//! Torna reference orderbook (CLOB) with token settlement.
//!
//! A market = two Torna trees (ask/bid) whose authority is a market PDA
//! seeds = [b"book", market_id]. The same PDA owns the base vault (escrow). Ask makers
//! escrow `size` base into the vault at PlaceOrder; a buy taker's Match releases base
//! from the vault to the taker and pays each maker quote, atomically with removing/
//! reducing the order in the book. Cancel refunds the escrow. The book (sorted, parallel)
//! is Torna; ownership + matching + settlement are this program.
//!
//! Order key (32B) mirrors torna_sdk::keys::order_key. Value (40B): maker(32)|size_be(8).
//! Token settlement is SPL-Token CPI (standard plumbing, not the Torna innovation).

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction}, program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError, pubkey::Pubkey,
};

const PLACE: u8 = 0;
const CANCEL: u8 = 1;
const MATCH: u8 = 2;
const ASK: u8 = 0;
const MAXK: usize = 8;

// SPL Token program + token-account layout
const TOKEN_PROGRAM: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TA_OWNER: usize = 32;
const TOKEN_TRANSFER: u8 = 3;

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
fn price_of(book_side: u8, key: &[u8; 32]) -> u64 {
    let p = u64::from_be_bytes(key[0..8].try_into().unwrap());
    if book_side == ASK { p } else { u64::MAX - p }
}

/// SPL-Token Transfer CPI. `seeds` = Some(market PDA seeds) when the vault (PDA-owned)
/// is the source; None when the signer authorizes (e.g. the maker/taker).
fn token_transfer<'a>(
    token_program: &AccountInfo<'a>, source: &AccountInfo<'a>, dest: &AccountInfo<'a>,
    authority: &AccountInfo<'a>, amount: u64, seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    if token_program.key != &TOKEN_PROGRAM { return Err(ProgramError::IncorrectProgramId); }
    let mut data = vec![TOKEN_TRANSFER];
    data.extend_from_slice(&amount.to_le_bytes());
    let metas = vec![
        AccountMeta::new(*source.key, false),
        AccountMeta::new(*dest.key, false),
        AccountMeta::new_readonly(*authority.key, true),
    ];
    let ix = Instruction { program_id: TOKEN_PROGRAM, accounts: metas, data };
    let infos = [source.clone(), dest.clone(), authority.clone(), token_program.clone()];
    match seeds { Some(s) => invoke_signed(&ix, &infos, s), None => invoke(&ix, &infos) }
}

fn process(_pid: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    match data[0] {
        PLACE => place(accounts, data),
        CANCEL => cancel(accounts, data),
        MATCH => matcher(accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// PlaceOrder (ask): escrow `size` base into the vault, then insert into the ask book.
/// data: [0][side][price u64][size u64][slot_est u64][nonce u64][market_id u64][bump u8]
/// accounts: [maker(s), market_pda, torna, header, maker_base(w), base_vault(w),
///            token_program, path(leaf w)]
fn place(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 43 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 8 { return Err(ProgramError::NotEnoughAccountKeys); }
    let side = data[1];
    let price = rd_u64(data, 2);
    let size = rd_u64(data, 10);
    let slot_est = rd_u64(data, 18);
    let nonce = rd_u64(data, 26);
    let market_id = rd_u64(data, 34);
    let bump = data[42];
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    // escrow base into the vault (maker authorizes; they are the tx signer)
    token_transfer(&accounts[6], &accounts[4], &accounts[5], maker, size, None)?;

    let key = order_key(side, price, slot_est, maker.key, nonce);
    let value = order_value(maker.key, size);
    let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];
    torna_cpi::insert_fast(&accounts[2], &accounts[1], &accounts[3], &accounts[7..], &key, &value, &[seeds])
}

/// CancelOrder: refund the escrowed base, then remove the order.
/// data: [1][key 32][market_id u64][bump u8]
/// accounts: [maker(s), market_pda, torna, header, base_vault(w), maker_base(w),
///            token_program, path(leaf w)]
fn cancel(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 42 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 8 { return Err(ProgramError::NotEnoughAccountKeys); }
    let key: [u8; 32] = data[1..33].try_into().unwrap();
    let market_id = rd_u64(data, 33);
    let bump = data[41];
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if key[16..24] != maker.key.to_bytes()[0..8] { return Err(ProgramError::IllegalOwner); }

    // read the order's escrowed size from the leaf (last path account)
    let size = order_size_in_leaf(&accounts[3], accounts.last().unwrap(), &key)?;

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    // refund base (vault -> maker; the market PDA owns the vault)
    token_transfer(&accounts[6], &accounts[4], &accounts[5], &accounts[1], size, Some(&[seeds]))?;
    torna_cpi::delete_fast(&accounts[2], &accounts[1], &accounts[3], &accounts[7..], &key, &[seeds])
}

/// Read the size of `key` from a leaf (returns err if absent).
fn order_size_in_leaf(header: &AccountInfo, leaf: &AccountInfo, key: &[u8; 32]) -> Result<u64, ProgramError> {
    let hd = header.try_borrow_data()?;
    let fanout = u16::from_le_bytes(hd[H_FANOUT..H_FANOUT + 2].try_into().unwrap()) as usize;
    let vs = u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) as usize;
    let ld = leaf.try_borrow_data()?;
    let cnt = u16::from_le_bytes(ld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
    let voff = NODE_HDR + (fanout + 1) * 32;
    for i in 0..cnt {
        if &ld[NODE_HDR + i * 32..NODE_HDR + i * 32 + 32] == key {
            return Ok(u64::from_be_bytes(ld[voff + i * vs + 32..voff + i * vs + 40].try_into().unwrap()));
        }
    }
    Err(ProgramError::InvalidArgument)
}

/// Match a buy taker against the ask book's best leaf, settling tokens atomically.
/// data: [2][book_side u8][limit u64][size u64][max_fills u8][market_id u64][bump u8]
/// accounts: [taker(s), market_pda, torna, header, base_vault(w), taker_base(w),
///            taker_quote(w), token_program, maker_quote[0..K](w), path(leaf w)]
/// return_data: [n][(maker 32, price_be u64, fill_be u64)*n].
fn matcher(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 28 { return Err(ProgramError::InvalidInstructionData); }
    let book_side = data[1];
    let limit = rd_u64(data, 2);
    let mut remaining = rd_u64(data, 10);
    let max_fills = (data[18] as usize).min(MAXK);
    let market_id = rd_u64(data, 19);
    let bump = data[27];
    // fixed accounts (8) + K maker_quote + path(>=1)
    if accounts.len() < 8 + max_fills + 1 { return Err(ProgramError::NotEnoughAccountKeys); }
    if !accounts[0].is_signer { return Err(ProgramError::MissingRequiredSignature); }
    let header = &accounts[3];
    let leaf = accounts.last().unwrap();

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
        if vs < 40 { return Err(ProgramError::InvalidAccountData); }
        let ld = leaf.try_borrow_data()?;
        if u64::from_le_bytes(ld[N_NODE_IDX..N_NODE_IDX + 8].try_into().unwrap()) != leftmost {
            return Err(ProgramError::InvalidArgument);
        }
        let cnt = u16::from_le_bytes(ld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
        let voff = NODE_HDR + (fanout + 1) * 32;
        for i in 0..cnt {
            if remaining == 0 || nf >= max_fills { break; }
            let key: [u8; 32] = ld[NODE_HDR + i * 32..NODE_HDR + i * 32 + 32].try_into().unwrap();
            let price = price_of(book_side, &key);
            let cross = if book_side == ASK { price <= limit } else { price >= limit };
            if !cross { break; }
            let vo = voff + i * vs;
            let resting = u64::from_be_bytes(ld[vo + 32..vo + 40].try_into().unwrap());
            let fill = remaining.min(resting);
            keys[nf] = key;
            makers[nf].copy_from_slice(&ld[vo..vo + 32]);
            prices[nf] = price;
            fills[nf] = fill;
            new_sizes[nf] = resting - fill;
            remaining -= fill;
            nf += 1;
        }
    }

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    let path = &accounts[8 + max_fills..];
    for j in 0..nf {
        // settle: release base (vault -> taker) and collect quote (taker -> maker)
        let maker_quote = &accounts[8 + j];
        if maker_quote.try_borrow_data()?[TA_OWNER..TA_OWNER + 32] != makers[j] {
            return Err(ProgramError::IllegalOwner); // wrong maker quote account passed
        }
        let quote_amt = prices[j].checked_mul(fills[j]).ok_or(ProgramError::ArithmeticOverflow)?;
        token_transfer(&accounts[7], &accounts[4], &accounts[5], &accounts[1], fills[j], Some(&[seeds]))?;
        token_transfer(&accounts[7], &accounts[6], maker_quote, &accounts[0], quote_amt, None)?;
        // update the book
        if new_sizes[j] == 0 {
            torna_cpi::delete_fast(&accounts[2], &accounts[1], header, path, &keys[j], &[seeds])?;
        } else {
            let m = Pubkey::new_from_array(makers[j]);
            let v = order_value(&m, new_sizes[j]);
            torna_cpi::update_fast(&accounts[2], &accounts[1], header, path, &keys[j], &v, &[seeds])?;
        }
    }

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
