//! Torna reference orderbook (CLOB) -- v1: PlaceOrder + CancelOrder.
//!
//! A market is two Torna trees (ask book, bid book) whose authority is a market PDA
//! seeds = [b"book", market_id]. The client sets the trees up (init + transfer
//! authority to the market PDA) and resolves the Torna account set; this program
//! validates ownership, builds the order key from the REAL signer + params (so a maker
//! cannot forge price/owner), and drives the book via torna-cpi, signing as the market
//! PDA. The authority PDA is a READ-ONLY signer, so disjoint-price place/cancel stay
//! parallel (the whole point).
//!
//! Order key (32B) -- mirrors torna_sdk::keys::order_key:
//!   asks: price_be(8)            | slot_be(8) | maker[0..8] | nonce_be(8)
//!   bids: (u64::MAX-price)_be(8) | slot_be(8) | maker[0..8] | nonce_be(8)
//! price first -> price priority; slot -> approximate FIFO; maker|nonce -> writer-unique.
//! Order value (40B): maker(32) | size_be(8).

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    program::set_return_data, program_error::ProgramError, pubkey::Pubkey,
};

const PLACE: u8 = 0;
const CANCEL: u8 = 1;
const MATCH: u8 = 2;
const ASK: u8 = 0;
const MAXK: usize = 16; // max fills per match tx (taker re-submits to sweep deeper)

// torna node/header layout (mirrors abi.md)
const NODE_HDR: usize = 44;
const H_VALUE_SIZE: usize = 46;
const H_FANOUT: usize = 48;
const H_LEFTMOST: usize = 66;
const N_KEY_COUNT: usize = 2;
const N_NODE_IDX: usize = 12;

entrypoint!(process);

fn rd_u64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }

fn order_key(side: u8, price: u64, slot: u64, maker: &Pubkey, nonce: u64) -> [u8; 32] {
    let p = if side == ASK { price } else { u64::MAX - price };
    let mut k = [0u8; 32];
    k[0..8].copy_from_slice(&p.to_be_bytes());
    k[8..16].copy_from_slice(&slot.to_be_bytes());
    k[16..24].copy_from_slice(&maker.to_bytes()[0..8]);
    k[24..32].copy_from_slice(&nonce.to_be_bytes());
    k
}

fn order_value(maker: &Pubkey, size: u64) -> [u8; 40] {
    let mut v = [0u8; 40];
    v[0..32].copy_from_slice(maker.as_ref());
    v[32..40].copy_from_slice(&size.to_be_bytes());
    v
}

fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    match data[0] {
        PLACE => place(accounts, data),
        CANCEL => cancel(accounts, data),
        MATCH => matcher(accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn price_of(book_side: u8, key: &[u8; 32]) -> u64 {
    let p = u64::from_be_bytes(key[0..8].try_into().unwrap());
    if book_side == ASK { p } else { u64::MAX - p }
}

/// Match a taker against the OPPOSITE book's best (leftmost) leaf. data:
///   [2][book_side u8][limit_price u64][size u64][max_fills u8][market_id u64][bump u8]
/// book_side = the side being TAKEN (ASK for a taker buy). accounts:
///   [taker(s), market_pda, torna_program, header, path(root..leftmost leaf, leaf w)]
/// return_data: [n_fills u8][(maker 32, price_be u64, fill_be u64) * n].
/// Settlement layer reads the fills and moves tokens (out of scope for v1).
fn matcher(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 28 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 5 { return Err(ProgramError::NotEnoughAccountKeys); }
    let book_side = data[1];
    let limit = rd_u64(data, 2);
    let mut remaining = rd_u64(data, 10);
    let max_fills = (data[18] as usize).min(MAXK);
    let market_id = rd_u64(data, 19);
    let bump = data[27];

    if !accounts[0].is_signer { return Err(ProgramError::MissingRequiredSignature); }
    let header = &accounts[3];
    let leaf = accounts.last().unwrap();

    // phase 1 (read-only): collect the crossing orders from the leftmost leaf
    let mut keys = [[0u8; 32]; MAXK];
    let mut makers = [[0u8; 32]; MAXK];
    let mut prices = [0u64; MAXK];
    let mut fills = [0u64; MAXK];
    let mut new_sizes = [0u64; MAXK];
    let mut nf = 0usize;
    {
        let hd = header.try_borrow_data()?;
        let fanout = u16::from_le_bytes(hd[H_FANOUT..H_FANOUT + 2].try_into().unwrap()) as usize;
        let vs = u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) as usize;
        let leftmost = u64::from_le_bytes(hd[H_LEFTMOST..H_LEFTMOST + 8].try_into().unwrap());
        if vs < 40 { return Err(ProgramError::InvalidAccountData); } // value = maker(32)+size(8)
        let ld = leaf.try_borrow_data()?;
        // the passed leaf MUST be the book's best (leftmost) leaf
        if u64::from_le_bytes(ld[N_NODE_IDX..N_NODE_IDX + 8].try_into().unwrap()) != leftmost {
            return Err(ProgramError::InvalidArgument);
        }
        let cnt = u16::from_le_bytes(ld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
        let voff = NODE_HDR + (fanout + 1) * 32;
        for i in 0..cnt {
            if remaining == 0 || nf >= max_fills { break; }
            let ko = NODE_HDR + i * 32;
            let key: [u8; 32] = ld[ko..ko + 32].try_into().unwrap();
            let price = price_of(book_side, &key);
            let cross = if book_side == ASK { price <= limit } else { price >= limit };
            if !cross { break; } // sorted: first non-crossing order ends the sweep
            let vo = voff + i * vs;
            let resting = u64::from_be_bytes(ld[vo + 32..vo + 40].try_into().unwrap());
            let fill = remaining.min(resting);
            keys[nf] = key;
            makers[nf].copy_from_slice(&ld[vo..vo + 32]);
            prices[nf] = price;
            fills[nf] = fill;
            new_sizes[nf] = resting - fill; // 0 => fully filled
            remaining -= fill;
            nf += 1;
        }
    } // borrows dropped before any CPI mutates the leaf

    // phase 2 (CPI): apply fills by KEY (position-independent as the leaf shifts)
    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    let path = &accounts[4..];
    for j in 0..nf {
        if new_sizes[j] == 0 {
            torna_cpi::delete_fast(&accounts[2], &accounts[1], header, path, &keys[j], &[seeds])?;
        } else {
            let m = Pubkey::new_from_array(makers[j]);
            let v = order_value(&m, new_sizes[j]);
            torna_cpi::update_fast(&accounts[2], &accounts[1], header, path, &keys[j], &v, &[seeds])?;
        }
    }

    // return the fills for the settlement layer
    let mut out = Vec::with_capacity(1 + nf * 48);
    out.push(nf as u8);
    for j in 0..nf {
        out.extend_from_slice(&makers[j]);
        out.extend_from_slice(&prices[j].to_be_bytes());
        out.extend_from_slice(&fills[j].to_be_bytes());
    }
    set_return_data(&out);
    Ok(())
}

/// PlaceOrder. data: [0][side u8][price u64][size u64][slot_est u64][nonce u64]
///                    [market_id u64][bump u8]
/// accounts: [maker(s,fee), book_authority_pda, torna_program, header, path(leaf w)]
fn place(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 43 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 5 { return Err(ProgramError::NotEnoughAccountKeys); }
    let side = data[1];
    let price = rd_u64(data, 2);
    let size = rd_u64(data, 10);
    let slot_est = rd_u64(data, 18);
    let nonce = rd_u64(data, 26);
    let market_id = rd_u64(data, 34);
    let bump = data[42];

    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    // build the key + value from the REAL signer -> a maker cannot forge owner/price
    let key = order_key(side, price, slot_est, maker.key, nonce);
    let value = order_value(maker.key, size);

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    torna_cpi::insert_fast(
        &accounts[2], &accounts[1], &accounts[3], &accounts[4..],
        &key, &value, &[seeds],
    )
}

/// CancelOrder. data: [1][key 32][market_id u64][bump u8]
/// accounts: [maker(s), book_authority_pda, torna_program, header, path(leaf w)]
fn cancel(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 42 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 5 { return Err(ProgramError::NotEnoughAccountKeys); }
    let key: [u8; 32] = data[1..33].try_into().unwrap();
    let market_id = rd_u64(data, 33);
    let bump = data[41];

    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    // ownership: the key carries the placer's 8-byte maker prefix (set at PlaceOrder
    // from the real signer); only that maker may cancel.
    if key[16..24] != maker.key.to_bytes()[0..8] {
        return Err(ProgramError::IllegalOwner);
    }

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    torna_cpi::delete_fast(
        &accounts[2], &accounts[1], &accounts[3], &accounts[4..],
        &key, &[seeds],
    )
}
