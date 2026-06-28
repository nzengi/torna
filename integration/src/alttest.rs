//! Proves the v0 + Address Lookup Table transport works with Torna: a multi-leaf
//! match (or any op) references its node accounts through an ALT, so deep sweeps fit
//! a v0 transaction. Here we drive an InsertFast via a v0+ALT tx and confirm the key
//! lands -- the orderbook program is byte-identical under this envelope (it just
//! receives the accounts), so this validates the scale path for multi-leaf matching.

use litesvm::LiteSVM;
use solana_address_lookup_table_interface::instruction::{create_lookup_table, extend_lookup_table};
use solana_sdk::{
    clock::Clock,
    message::{v0, AddressLookupTableAccount, VersionedMessage},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::{Transaction, VersionedTransaction},
    message::Message,
};
use torna_sdk::{AccountReader, Tree};

const VS: u16 = 8;
const F: u16 = 64;
const TID: u32 = 1;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }
fn node_size(f: usize, vs: usize) -> usize {
    (44 + (f + 1) * 32 + (f + 1) * vs).max(44 + (f + 1) * 32 + (f + 2) * 8)
}
struct R<'a>(&'a LiteSVM);
impl AccountReader for R<'_> {
    fn account_data(&self, k: &Pubkey) -> Option<Vec<u8>> { self.0.get_account(k).map(|a| a.data) }
}

fn main() {
    let bytes = std::fs::read("../sbf/out/torna.so").expect("torna.so");
    let prog = Pubkey::new_unique();
    let mut svm = LiteSVM::new();
    svm.add_program(prog, &bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    let me = payer.pubkey();
    let tree = Tree::new(prog, me, TID);
    let rent = |svm: &LiteSVM, n: usize| svm.minimum_balance_for_rent_exemption(n);

    let (mut pass, mut fail) = (0u32, 0u32);
    macro_rules! check { ($c:expr, $m:expr) => {
        if $c { pass += 1; println!("ok   {}", $m); } else { fail += 1; println!("FAIL {}", $m); } }; }
    macro_rules! send { ($ix:expr) => {{
        let bh = svm.latest_blockhash();
        let tx = Transaction::new(&[&payer], Message::new(&[$ix], Some(&me)), bh);
        svm.send_transaction(tx).map_err(|m| format!("{:?}", m.err))
    }}; }

    // tree + a seeded leaf so InsertFast has somewhere to go
    send!(tree.init_tree_ix(me, VS, F, rent(&svm, 146), rent(&svm, 32))).expect("init");
    let ix = { let r = R(&svm); tree.insert_ix(&r, me, &k32(50), &[50u8; VS as usize], rent(&svm, node_size(F as usize, VS as usize))).unwrap() };
    send!(ix).expect("seed");

    // build the InsertFast we will route through an ALT
    let key = k32(60);
    let ix = { let r = R(&svm); tree.insert_fast_ix(&r, me, &key, &[60u8; VS as usize]).unwrap() };
    // ALT holds the non-signer accounts (header + path nodes); signer + program stay static
    let alt_addrs: Vec<Pubkey> = ix.accounts.iter().filter(|m| !m.is_signer).map(|m| m.pubkey).collect();

    // create + extend the lookup table, then warp a slot to activate it
    let slot = svm.get_sysvar::<Clock>().slot;
    let (create_ix, table) = create_lookup_table(me, me, slot);
    send!(create_ix).expect("create ALT");
    send!(extend_lookup_table(table, me, Some(me), alt_addrs.clone())).expect("extend ALT");
    svm.warp_to_slot(slot + 1);
    check!(svm.get_account(&table).is_some(), "ALT created + extended on chain");

    // compile a v0 tx that resolves header+path through the ALT
    let alt = AddressLookupTableAccount { key: table, addresses: alt_addrs.clone() };
    let bh = svm.latest_blockhash();
    let msg = v0::Message::try_compile(&me, &[ix], &[alt], bh).expect("compile v0");
    let n_static = msg.account_keys.len();
    let vtx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &[&payer]).expect("v0 tx");
    check!(svm.send_transaction(vtx).is_ok(), "v0+ALT InsertFast lands");
    check!({ let r = R(&svm); tree.get(&r, &key).map(|v| v[0]) } == Some(60), "v0+ALT: key 60 inserted via lookup table");
    check!(n_static <= 3 && !alt_addrs.is_empty(),
           "v0 static keys compressed (signer+program+ALT-table) while nodes live in the ALT");

    println!("\nalttest (v0 + ALT transport): pass={pass} fail={fail} -> {}",
             if fail == 0 { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
