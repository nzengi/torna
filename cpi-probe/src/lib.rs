use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    program_error::ProgramError, pubkey::Pubkey,
};

entrypoint!(process);

// accounts: [torna_program, book_pda, header, path... (leaf last)]
// data    : [bump u8][key 32][value vs]
fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 1 + 32 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 4 { return Err(ProgramError::NotEnoughAccountKeys); }
    let bump = data[0];
    let key: &[u8; 32] = data[1..33].try_into().unwrap();
    let value = &data[33..];
    let path = &accounts[3..];
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[b"book", &bump_arr];
    torna_cpi::insert_fast(&accounts[0], &accounts[1], &accounts[2], path, key, value, &[seeds])
}
