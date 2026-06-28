//! Torna on-chain CPI helpers.
//!
//! An integrating program (e.g. an orderbook) receives the Torna accounts already
//! resolved by the client (via torna-sdk's PathPlanner), validates/settles its own
//! state, then calls one of these to mutate the book -- signing as a book-authority
//! PDA. The account ORDER the caller passes is [authority_pda, header, path...]
//! (root..leaf); the Torna program account is passed separately.
//!
//! Because the authority PDA is a READ-ONLY signer and only the leaf is writable,
//! disjoint-key place/cancel/modify stay parallel THROUGH the CPI (proven by
//! integration/cpitest).

#![allow(clippy::too_many_arguments)]

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey::Pubkey,
};

pub const IX_INSERT_FAST: u8 = 16;
pub const IX_UPDATE_FAST: u8 = 17;
pub const IX_DELETE_FAST: u8 = 18;

/// Place a new key/value into an existing leaf (fails if the leaf is full).
pub fn insert_fast<'a>(
    torna_program: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    header: &AccountInfo<'a>,
    path: &[AccountInfo<'a>],
    key: &[u8; 32],
    value: &[u8],
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let mut data = Vec::with_capacity(1 + 32 + value.len() + 1);
    data.push(IX_INSERT_FAST);
    data.extend_from_slice(key);
    data.extend_from_slice(value);
    data.push(path.len() as u8);
    invoke_fast(torna_program, authority, header, path, data, signer_seeds)
}

/// Overwrite the value of an existing key in place (e.g. reduce an order's size).
pub fn update_fast<'a>(
    torna_program: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    header: &AccountInfo<'a>,
    path: &[AccountInfo<'a>],
    key: &[u8; 32],
    value: &[u8],
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let mut data = Vec::with_capacity(1 + 32 + value.len() + 1);
    data.push(IX_UPDATE_FAST);
    data.extend_from_slice(key);
    data.extend_from_slice(value);
    data.push(path.len() as u8);
    invoke_fast(torna_program, authority, header, path, data, signer_seeds)
}

/// Remove a key without rebalancing (a leaf may drop below MIN; cold Delete compacts).
pub fn delete_fast<'a>(
    torna_program: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    header: &AccountInfo<'a>,
    path: &[AccountInfo<'a>],
    key: &[u8; 32],
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let mut data = Vec::with_capacity(1 + 32 + 1);
    data.push(IX_DELETE_FAST);
    data.extend_from_slice(key);
    data.push(path.len() as u8);
    invoke_fast(torna_program, authority, header, path, data, signer_seeds)
}

/// Build the Torna hot-path instruction [header ro, authority signer, path(leaf w)]
/// and invoke_signed it. Shared by all three ops.
fn invoke_fast<'a>(
    torna_program: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    header: &AccountInfo<'a>,
    path: &[AccountInfo<'a>],
    data: Vec<u8>,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let mut metas: Vec<AccountMeta> = Vec::with_capacity(2 + path.len());
    metas.push(AccountMeta::new_readonly(*header.key, false));
    metas.push(AccountMeta::new_readonly(*authority.key, true));
    for (i, a) in path.iter().enumerate() {
        let is_leaf = i == path.len() - 1;
        metas.push(AccountMeta {
            pubkey: *a.key,
            is_signer: false,
            is_writable: is_leaf, // only the leaf is writable -> stays parallel
        });
    }
    let ix = Instruction { program_id: *torna_program.key, accounts: metas, data };

    let mut infos: Vec<AccountInfo<'a>> = Vec::with_capacity(3 + path.len());
    infos.push(torna_program.clone());
    infos.push(header.clone());
    infos.push(authority.clone());
    infos.extend(path.iter().cloned());

    invoke_signed(&ix, &infos, signer_seeds)
}

/// Derive a book-authority PDA from seeds under `owner` (the integrating program).
/// Convention: seeds = [b"book", market_id]. Returns (pda, bump).
pub fn book_authority(owner: &Pubkey, market_id: &[u8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"book", market_id], owner)
}
