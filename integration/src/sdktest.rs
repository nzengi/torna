//! Proves the torna-sdk PathPlanner against the REAL torna.so via LiteSVM: build a
//! tree and drive every single-key op through the SDK's instruction builders (no
//! hand-rolled accounts), then verify with Find. If the SDK's layout/PDA/path logic
//! is wrong, the engine rejects the tx and a check fails.

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::AccountMeta, message::Message, pubkey::Pubkey,
    signature::{Keypair, Signer}, transaction::Transaction,
};
use torna_sdk::{AccountReader, Tree};

const F: u16 = 8;
const VS: u16 = 8;
const TID: u32 = 1;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }

struct SvmReader<'a>(&'a LiteSVM);
impl AccountReader for SvmReader<'_> {
    fn account_data(&self, key: &Pubkey) -> Option<Vec<u8>> { self.0.get_account(key).map(|a| a.data) }
}

fn main() {
    let bytes = std::fs::read("../sbf/out/torna.so").expect("torna.so (make sbf)");
    let prog = Pubkey::new_unique();
    let mut svm = LiteSVM::new();
    svm.add_program(prog, &bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    let me = payer.pubkey();
    let tree = Tree::new(prog, me, TID);

    let rent = |svm: &LiteSVM, n: usize| svm.minimum_balance_for_rent_exemption(n);
    // node_size for F=8, vs=8: 44 + 9*32 + max(9*8, 10*8) = 44+288+80 = 412
    let node_size = 44 + 9 * 32 + std::cmp::max(9 * (VS as usize), 10 * 8);

    let (mut pass, mut fail) = (0u32, 0u32);
    macro_rules! check { ($c:expr, $m:expr) => {
        if $c { pass += 1; } else { println!("FAIL: {}", $m); fail += 1; } }; }

    // send a tx; return its return_data
    // append a tx-unique account so LiteSVM's signature-dedup never returns a stale
    // result for two identical SDK instructions (the engine ignores trailing accounts)
    macro_rules! send {
        ($ix:expr) => {{
            let mut ix = $ix;
            ix.accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
            let bh = svm.latest_blockhash();
            let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&me)), bh);
            svm.send_transaction(tx).map(|m| m.return_data.data).map_err(|m| format!("{:?}", m.err))
        }};
    }
    macro_rules! resolve { ($build:expr) => {{ let r = SvmReader(&svm); $build(&r) }}; }

    // InitTree via SDK
    let rh = rent(&svm, 146); let ra = rent(&svm, 32);
    send!(tree.init_tree_ix(me, VS, F, rh, ra)).expect("init");
    check!(resolve!(|r| tree.header(r)).map(|h| h.height) == Some(0), "SDK reads fresh header height=0");

    // build a tree with the SDK's cold-path Insert (forces splits -> height grows)
    let rn = rent(&svm, node_size);
    for n in 1u32..=20 {
        let ix = resolve!(|r| tree.insert_ix(r, me, &k32(n), &[(n & 0xFF) as u8; VS as usize], rn)).unwrap();
        send!(ix).unwrap_or_else(|e| panic!("insert {n}: {e}"));
    }
    let h = resolve!(|r| tree.header(r)).unwrap();
    check!(h.height >= 2, "SDK-built tree split (height >= 2)");

    // client-side reads via the SDK (no tx): top-of-book, depth, get-by-key
    {
        let r = SvmReader(&svm);
        let top = tree.best(&r).unwrap();
        check!(top.0 == k32(1) && top.1[0] == 1, "SDK best() = smallest key (top of book)");
        let keys: Vec<u32> = tree.scan(&r, 5).iter()
            .map(|(k, _)| u32::from_be_bytes(k[28..32].try_into().unwrap())).collect();
        check!(keys == vec![1, 2, 3, 4, 5], "SDK scan() returns the first 5 in order");
        check!(tree.get(&r, &k32(12)).map(|v| v[0]) == Some(12), "SDK get(key) returns its value");
        check!(tree.get(&r, &k32(999)).is_none(), "SDK get(missing) = None");
    }

    // Find via SDK (read-only; send_transaction advances the slot, hence a macro)
    macro_rules! find { ($n:expr) => {{
        let mut ix = { let r = SvmReader(&svm); tree.find_ix(&r, &k32($n)).unwrap() };
        ix.accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
        let bh = svm.latest_blockhash();
        let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&me)), bh);
        let d = svm.send_transaction(tx).map(|m| m.return_data.data).unwrap_or_default();
        (!d.is_empty() && d[0] == 1, if d.len() > 1 { d[1] } else { 0u8 })
    }}; }

    check!(find!(7) == (true, 7), "SDK Find returns an inserted key + value");

    // UpdateFast via SDK -> value changes
    let ix = resolve!(|r| tree.update_fast_ix(r, me, &k32(7), &[0xAB; VS as usize])).unwrap();
    send!(ix).expect("update_fast");
    check!(find!(7) == (true, 0xAB), "SDK UpdateFast changed the value");

    // DeleteFast via SDK -> key gone
    let ix = resolve!(|r| tree.delete_fast_ix(r, me, &k32(7)).unwrap());
    send!(ix).expect("delete_fast");
    check!(!find!(7).0, "SDK DeleteFast removed the key");

    // InsertFast via SDK into an existing (non-full) leaf -> key present
    let ix = resolve!(|r| tree.insert_fast_ix(r, me, &k32(7), &[0x5C; VS as usize]).unwrap());
    send!(ix).expect("insert_fast");
    check!(find!(7) == (true, 0x5C), "SDK InsertFast re-added the key");

    println!("sdktest (PathPlanner vs real engine): pass={pass} fail={fail} -> {}",
             if fail == 0 { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
