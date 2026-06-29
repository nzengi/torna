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
const PLACE_COLD: u8 = 3;
const INIT_MARKET: u8 = 4;
const ASK: u8 = 0;
const MAXK: usize = 8;

// SPL Token program + token-account layout (mint @0, owner @32, amount @64)
const TOKEN_PROGRAM: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TA_MINT: usize = 0;
const TA_OWNER: usize = 32;
const TOKEN_TRANSFER: u8 = 3;

// Market config PDA [b"mkt", market_id]: the canonical mints, vaults, AND book (torna
// program + ask/bid tree headers) of a market. Binding the BOOK (not just the vaults)
// is what stops a taker from settling against a fake tree while draining the real vault.
const MARKET_MAGIC: u32 = 0x344b_544d; // "MTK4"
const TORNA_MAGIC: u32 = 0x3454_4254;  // "TBT4" -- a genuine Torna header
const MARKET_SIZE: usize = 229; // magic(4)+cfg_bump(1)+7*32 (base/quote mint, base/quote
                                // vault, torna_program, ask_header, bid_header)

// torna node/header layout (mirrors abi.md)
const NODE_HDR: usize = 44;
const H_VALUE_SIZE: usize = 46;
const H_FANOUT: usize = 48;
const H_LEFTMOST: usize = 66;
const N_KEY_COUNT: usize = 2;
const N_NODE_IDX: usize = 12;
const N_NEXT_LEAF: usize = 20;

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

// ---- Market config (canonical mints + vaults + book) ----
struct Cfg {
    base_mint: [u8; 32], quote_mint: [u8; 32], base_vault: [u8; 32], quote_vault: [u8; 32],
    torna_program: [u8; 32], ask_header: [u8; 32], bid_header: [u8; 32],
}

fn ta_field(a: &AccountInfo, off: usize) -> Result<[u8; 32], ProgramError> {
    let d = a.try_borrow_data()?;
    if d.len() < 72 { return Err(ProgramError::InvalidAccountData); } // not a token account
    Ok(d[off..off + 32].try_into().unwrap())
}

/// Read + authenticate the market config: program-owned, right magic, and the canonical
/// [b"mkt", market_id] PDA (re-derived from its own stored bump). Returns the config.
fn read_cfg(cfg: &AccountInfo, program_id: &Pubkey, market_id: u64) -> Result<Cfg, ProgramError> {
    if cfg.owner != program_id { return Err(ProgramError::IncorrectProgramId); }
    let d = cfg.try_borrow_data()?;
    if d.len() < MARKET_SIZE || u32::from_le_bytes(d[0..4].try_into().unwrap()) != MARKET_MAGIC {
        return Err(ProgramError::InvalidAccountData);
    }
    let bump = d[4];
    let mid = market_id.to_le_bytes();
    let derived = Pubkey::create_program_address(&[b"mkt", &mid, &[bump]], program_id)
        .map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *cfg.key { return Err(ProgramError::InvalidArgument); }
    Ok(Cfg {
        base_mint: d[5..37].try_into().unwrap(),
        quote_mint: d[37..69].try_into().unwrap(),
        base_vault: d[69..101].try_into().unwrap(),
        quote_vault: d[101..133].try_into().unwrap(),
        torna_program: d[133..165].try_into().unwrap(),
        ask_header: d[165..197].try_into().unwrap(),
        bid_header: d[197..229].try_into().unwrap(),
    })
}

/// Verify the Torna program + the side's tree header match the market config (binds the
/// BOOK to the market, not just the vaults). `header_side`: true=ASK book, false=BID.
fn check_book(cfg: &Cfg, torna: &AccountInfo, header: &AccountInfo, ask_side: bool) -> ProgramResult {
    if torna.key.to_bytes() != cfg.torna_program { return Err(ProgramError::IncorrectProgramId); }
    let want = if ask_side { cfg.ask_header } else { cfg.bid_header };
    if header.key.to_bytes() != want { return Err(ProgramError::InvalidArgument); }
    Ok(())
}

/// InitMarket: create + write the market config PDA after validating the vaults are the
/// book PDA's token accounts of the declared mints. One-time per market.
/// data: [4][market_id u64][book_bump u8][cfg_bump u8][rent u64]
/// accounts: [payer(s,w), market_cfg(w), book_pda, base_mint, quote_mint, base_vault,
///            quote_vault, system, torna_program, ask_header, bid_header]
fn init_market(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 19 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 11 { return Err(ProgramError::NotEnoughAccountKeys); }
    let market_id = rd_u64(data, 1);
    let book_bump = data[9];
    let cfg_bump = data[10];
    let rent = rd_u64(data, 11);
    let (payer, cfg, book) = (&accounts[0], &accounts[1], &accounts[2]);
    let (base_mint, quote_mint, base_vault, quote_vault) =
        (&accounts[3], &accounts[4], &accounts[5], &accounts[6]);
    let (torna, ask_header, bid_header) = (&accounts[8], &accounts[9], &accounts[10]);
    if !payer.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    let mid = market_id.to_le_bytes();

    // the book authority PDA must be the canonical [b"book", market_id]
    let book_derived = Pubkey::create_program_address(&[b"book", &mid, &[book_bump]], program_id)
        .map_err(|_| ProgramError::InvalidArgument)?;
    if book_derived != *book.key { return Err(ProgramError::InvalidArgument); }
    // vaults must be the book PDA's token accounts of the declared mints
    if ta_field(base_vault, TA_OWNER)? != book.key.to_bytes() || ta_field(base_vault, TA_MINT)? != base_mint.key.to_bytes() {
        return Err(ProgramError::InvalidArgument);
    }
    if ta_field(quote_vault, TA_OWNER)? != book.key.to_bytes() || ta_field(quote_vault, TA_MINT)? != quote_mint.key.to_bytes() {
        return Err(ProgramError::InvalidArgument);
    }
    // the ask/bid headers must be GENUINE Torna headers (owner == torna program, magic).
    // The engine then enforces the book PDA as their write authority + leaf tenancy.
    for h in [ask_header, bid_header] {
        if h.owner != torna.key { return Err(ProgramError::IncorrectProgramId); }
        let hd = h.try_borrow_data()?;
        if hd.len() < 6 || u32::from_le_bytes(hd[0..4].try_into().unwrap()) != TORNA_MAGIC {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // create the config PDA (program-owned), signed by its seeds
    let mut cd = vec![0u8; 4];
    cd.extend_from_slice(&rent.to_le_bytes());
    cd.extend_from_slice(&(MARKET_SIZE as u64).to_le_bytes());
    cd.extend_from_slice(program_id.as_ref());
    let create = Instruction {
        program_id: Pubkey::default(), // system program
        accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*cfg.key, true)],
        data: cd,
    };
    invoke_signed(&create, &[payer.clone(), cfg.clone(), accounts[7].clone()],
        &[&[b"mkt", &mid, &[cfg_bump]]])?;

    let mut d = cfg.try_borrow_mut_data()?;
    d[0..4].copy_from_slice(&MARKET_MAGIC.to_le_bytes());
    d[4] = cfg_bump;
    d[5..37].copy_from_slice(base_mint.key.as_ref());
    d[37..69].copy_from_slice(quote_mint.key.as_ref());
    d[69..101].copy_from_slice(base_vault.key.as_ref());
    d[101..133].copy_from_slice(quote_vault.key.as_ref());
    d[133..165].copy_from_slice(torna.key.as_ref());
    d[165..197].copy_from_slice(ask_header.key.as_ref());
    d[197..229].copy_from_slice(bid_header.key.as_ref());
    Ok(())
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

fn process(pid: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    match data[0] {
        PLACE => place(pid, accounts, data),
        PLACE_COLD => place_cold(pid, accounts, data),
        CANCEL => cancel(pid, accounts, data),
        MATCH => matcher(pid, accounts, data),
        INIT_MARKET => init_market(pid, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// PlaceOrder (ask): escrow `size` base into the vault, then insert into the ask book.
/// data: [0][side][price u64][size u64][slot_est u64][nonce u64][market_id u64][bump u8]
/// accounts: [maker(s), market_pda, torna, header, maker_src(w), vault(w),
///            token_program, market_cfg, path(leaf w)]
fn place(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 43 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 9 { return Err(ProgramError::NotEnoughAccountKeys); }
    let side = data[1];
    let price = rd_u64(data, 2);
    let size = rd_u64(data, 10);
    let slot_est = rd_u64(data, 18);
    let nonce = rd_u64(data, 26);
    let market_id = rd_u64(data, 34);
    let bump = data[42];
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    // bind the escrow to the market's canonical vault + mint (per side)
    let cfg = read_cfg(&accounts[7], program_id, market_id)?;
    check_book(&cfg, &accounts[2], &accounts[3], side == ASK)?; // bind the book (program + tree)
    let (want_vault, want_mint) = if side == ASK { (cfg.base_vault, cfg.base_mint) } else { (cfg.quote_vault, cfg.quote_mint) };
    if accounts[5].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[4], TA_MINT)? != want_mint { return Err(ProgramError::InvalidArgument); }

    // escrow into the vault (maker authorizes). ASK locks `size` base; BID `price*size` quote.
    let escrow = if side == ASK { size } else { price.checked_mul(size).ok_or(ProgramError::ArithmeticOverflow)? };
    token_transfer(&accounts[6], &accounts[4], &accounts[5], maker, escrow, None)?;

    let key = order_key(side, price, slot_est, maker.key, nonce);
    let value = order_value(maker.key, size);
    let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];
    torna_cpi::insert_fast(&accounts[2], &accounts[1], &accounts[3], &accounts[8..], &key, &value, &[seeds])
}

/// PlaceOrderCold: place into a FULL leaf via the cold Insert path (split). Escrow as
/// in `place`; then a dual-signer cold Insert (maker pays spare rent + signs, the market
/// PDA authorizes). Client resolves path+spares via torna_sdk::Tree::cold_plan.
/// data: [3][side][price u64][size u64][slot u64][nonce u64][market_id u64][bump u8]
///        [path_len u8][spare_count u8][rent_node u64][spare_bumps * spare_count]
/// accounts: [maker(s), market_pda, torna, header(w), maker_src(w), vault(w), token,
///            alloc(w), system, market_cfg, path(w)..., spares(w)...]
fn place_cold(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 53 { return Err(ProgramError::InvalidInstructionData); }
    let side = data[1];
    let price = rd_u64(data, 2);
    let size = rd_u64(data, 10);
    let slot_est = rd_u64(data, 18);
    let nonce = rd_u64(data, 26);
    let market_id = rd_u64(data, 34);
    let bump = data[42];
    let path_len = data[43] as usize;
    let spare_count = data[44] as usize;
    let rent_node = rd_u64(data, 45);
    if data.len() < 53 + spare_count { return Err(ProgramError::InvalidInstructionData); }
    let spare_bumps = &data[53..53 + spare_count];
    if accounts.len() < 10 + path_len + spare_count { return Err(ProgramError::NotEnoughAccountKeys); }
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let cfg = read_cfg(&accounts[7], program_id, market_id)?; // [.. token(6), cfg(7), alloc(8), system(9), path(10)]
    check_book(&cfg, &accounts[2], &accounts[3], side == ASK)?;
    let (want_vault, want_mint) = if side == ASK { (cfg.base_vault, cfg.base_mint) } else { (cfg.quote_vault, cfg.quote_mint) };
    if accounts[5].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[4], TA_MINT)? != want_mint { return Err(ProgramError::InvalidArgument); }

    let escrow = if side == ASK { size } else { price.checked_mul(size).ok_or(ProgramError::ArithmeticOverflow)? };
    token_transfer(&accounts[6], &accounts[4], &accounts[5], maker, escrow, None)?;

    let key = order_key(side, price, slot_est, maker.key, nonce);
    let value = order_value(maker.key, size);
    let path = &accounts[10..10 + path_len];
    let spares = &accounts[10 + path_len..10 + path_len + spare_count];
    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    torna_cpi::insert_cold(&accounts[2], &accounts[1], &accounts[3], maker, &accounts[8], &accounts[9],
        path, spares, &key, &value, rent_node, spare_bumps, &[seeds])
}

/// CancelOrder: refund the escrow, then remove the order.
/// data: [1][key 32][side u8][market_id u64][bump u8]
/// accounts: [maker(s), market_pda, torna, header, vault(w), maker_dst(w),
///            token_program, market_cfg, path(leaf w)]  (vault/dst = base ASK, quote BID)
fn cancel(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 43 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 9 { return Err(ProgramError::NotEnoughAccountKeys); }
    let key: [u8; 32] = data[1..33].try_into().unwrap();
    let side = data[33];
    let market_id = rd_u64(data, 34);
    let bump = data[42];
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let cfg = read_cfg(&accounts[7], program_id, market_id)?;
    check_book(&cfg, &accounts[2], &accounts[3], side == ASK)?; // bind the book (program + tree)
    let (want_vault, want_mint) = if side == ASK { (cfg.base_vault, cfg.base_mint) } else { (cfg.quote_vault, cfg.quote_mint) };
    if accounts[4].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }

    // read the order's size + FULL maker from the real (bound) leaf; only the true
    // owner may cancel, and the refund must go to an account they own (not just the
    // right mint) -- the 8-byte key prefix alone is not a sound ownership proof.
    let (size, order_maker) = order_in_leaf(&accounts[3], accounts.last().unwrap(), &key)?;
    if order_maker != maker.key.to_bytes() { return Err(ProgramError::IllegalOwner); }
    if ta_field(&accounts[5], TA_MINT)? != want_mint { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[5], TA_OWNER)? != maker.key.to_bytes() { return Err(ProgramError::IllegalOwner); }

    // refund = what was escrowed: ASK -> size base; BID -> price*size quote
    let refund = if side == ASK { size }
        else { price_of(side, &key).checked_mul(size).ok_or(ProgramError::ArithmeticOverflow)? };

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    token_transfer(&accounts[6], &accounts[4], &accounts[5], &accounts[1], refund, Some(&[seeds]))?;
    torna_cpi::delete_fast(&accounts[2], &accounts[1], &accounts[3], &accounts[8..], &key, &[seeds])
}

/// Read the size + maker of `key` from a leaf (returns err if absent).
fn order_in_leaf(header: &AccountInfo, leaf: &AccountInfo, key: &[u8; 32]) -> Result<(u64, [u8; 32]), ProgramError> {
    let hd = header.try_borrow_data()?;
    let fanout = u16::from_le_bytes(hd[H_FANOUT..H_FANOUT + 2].try_into().unwrap()) as usize;
    let vs = u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) as usize;
    let ld = leaf.try_borrow_data()?;
    let cnt = u16::from_le_bytes(ld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
    let voff = NODE_HDR + (fanout + 1) * 32;
    for i in 0..cnt {
        if &ld[NODE_HDR + i * 32..NODE_HDR + i * 32 + 32] == key {
            let vo = voff + i * vs;
            let maker: [u8; 32] = ld[vo..vo + 32].try_into().unwrap();
            let size = u64::from_be_bytes(ld[vo + 32..vo + 40].try_into().unwrap());
            return Ok((size, maker));
        }
    }
    Err(ProgramError::InvalidArgument)
}

/// Match a buy taker against the ask book's best leaf, settling tokens atomically.
/// data: [2][book_side u8][limit u64][size u64][max_fills u8][market_id u64][bump u8]
/// accounts: [taker(s), market_pda, torna, header, vault(w), taker_recv(w),
///            taker_pay(w), token_program, market_cfg, maker_recv[0..K](w), path(leaf w)]
/// return_data: [n][(maker 32, price_be u64, fill_be u64)*n].
fn matcher(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 30 { return Err(ProgramError::InvalidInstructionData); }
    let book_side = data[1];
    let limit = rd_u64(data, 2);
    let mut remaining = rd_u64(data, 10);
    let max_fills = (data[18] as usize).min(MAXK);
    let market_id = rd_u64(data, 19);
    let bump = data[27];
    let num_leaves = data[28] as usize;
    let height = data[29] as usize;
    if num_leaves == 0 || height == 0 { return Err(ProgramError::InvalidInstructionData); }
    let base = 9 + max_fills; // [8 fixed + market_cfg] then maker_recv[K] then leaf groups
    if accounts.len() < base + num_leaves * height { return Err(ProgramError::NotEnoughAccountKeys); }
    if !accounts[0].is_signer { return Err(ProgramError::MissingRequiredSignature); }
    let header = &accounts[3];

    // bind settlement to the market's canonical vault + mints (per book side)
    let cfg = read_cfg(&accounts[8], program_id, market_id)?;
    check_book(&cfg, &accounts[2], &accounts[3], book_side == ASK)?; // bind the book (program + tree)
    let (want_vault, recv_mint, pay_mint) = if book_side == ASK {
        (cfg.base_vault, cfg.base_mint, cfg.quote_mint)
    } else {
        (cfg.quote_vault, cfg.quote_mint, cfg.base_mint)
    };
    if accounts[4].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[5], TA_MINT)? != recv_mint || ta_field(&accounts[6], TA_MINT)? != pay_mint {
        return Err(ProgramError::InvalidArgument);
    }
    let leaf_of = |g: usize| &accounts[base + g * height + (height - 1)]; // the leaf in group g

    let mut keys = [[0u8; 32]; MAXK];
    let mut makers = [[0u8; 32]; MAXK];
    let mut prices = [0u64; MAXK];
    let mut fills = [0u64; MAXK];
    let mut new_sizes = [0u64; MAXK];
    let mut grp = [0u8; MAXK]; // which leaf group each fill is in (its path for phase 2)
    let mut nf = 0usize;
    {
        let hd = header.try_borrow_data()?;
        let fanout = u16::from_le_bytes(hd[H_FANOUT..H_FANOUT + 2].try_into().unwrap()) as usize;
        let vs = u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) as usize;
        if vs < 40 { return Err(ProgramError::InvalidAccountData); }
        let voff = NODE_HDR + (fanout + 1) * 32;
        // leaf 0 must be the book's best (leftmost); each next must chain from the prev
        let mut expected = u64::from_le_bytes(hd[H_LEFTMOST..H_LEFTMOST + 8].try_into().unwrap());
        'sweep: for g in 0..num_leaves {
            if remaining == 0 || nf >= max_fills { break; }
            let ld = leaf_of(g).try_borrow_data()?;
            if u64::from_le_bytes(ld[N_NODE_IDX..N_NODE_IDX + 8].try_into().unwrap()) != expected {
                return Err(ProgramError::InvalidArgument); // wrong/out-of-order leaf
            }
            let cnt = u16::from_le_bytes(ld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
            for i in 0..cnt {
                if remaining == 0 || nf >= max_fills { break; }
                let key: [u8; 32] = ld[NODE_HDR + i * 32..NODE_HDR + i * 32 + 32].try_into().unwrap();
                let price = price_of(book_side, &key);
                let cross = if book_side == ASK { price <= limit } else { price >= limit };
                if !cross { break 'sweep; } // globally sorted -> first non-crosser ends it
                let vo = voff + i * vs;
                let resting = u64::from_be_bytes(ld[vo + 32..vo + 40].try_into().unwrap());
                let fill = remaining.min(resting);
                keys[nf] = key;
                makers[nf].copy_from_slice(&ld[vo..vo + 32]);
                prices[nf] = price; fills[nf] = fill; new_sizes[nf] = resting - fill; grp[nf] = g as u8;
                remaining -= fill; nf += 1;
            }
            expected = u64::from_le_bytes(ld[N_NEXT_LEAF..N_NEXT_LEAF + 8].try_into().unwrap());
        }
    }

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    for j in 0..nf {
        // settle. ASK book (taker buy): release `fill` base from vault -> taker, collect
        // `price*fill` quote taker -> maker. BID book (taker sell): mirror. The order is
        // mutated through its OWN leaf-group path (the sweep may span leaves).
        let maker_recv = &accounts[9 + j];
        {
            let md = maker_recv.try_borrow_data()?;
            if md.len() < 72 || md[TA_OWNER..TA_OWNER + 32] != makers[j] { return Err(ProgramError::IllegalOwner); }
            if md[TA_MINT..TA_MINT + 32] != pay_mint { return Err(ProgramError::InvalidArgument); } // maker must be paid the canonical mint
        }
        let quote_amt = prices[j].checked_mul(fills[j]).ok_or(ProgramError::ArithmeticOverflow)?;
        let (release, collect) = if book_side == ASK { (fills[j], quote_amt) } else { (quote_amt, fills[j]) };
        token_transfer(&accounts[7], &accounts[4], &accounts[5], &accounts[1], release, Some(&[seeds]))?;
        token_transfer(&accounts[7], &accounts[6], maker_recv, &accounts[0], collect, None)?;
        let g = grp[j] as usize;
        let path = &accounts[base + g * height..base + (g + 1) * height];
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
