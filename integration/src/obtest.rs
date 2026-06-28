//! Proves the reference orderbook end to end: client (torna-sdk) -> orderbook program
//! -> torna-cpi -> torna engine. A maker places + cancels an ask through the orderbook
//! program (which signs as the market PDA); the order is verified in the real book via
//! the SDK; a non-owner cannot cancel.

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction}, message::Message, pubkey::Pubkey,
    signature::{Keypair, Signer}, transaction::Transaction,
};
use torna_sdk::{keys, AccountReader, Tree};

const TID: u32 = 1;
const VS: u16 = 40; // order value = maker(32) + size(8)
const F: u16 = 64;
const MARKET_ID: u64 = 1;
const ASK: u8 = 0;

struct R<'a>(&'a LiteSVM);
impl AccountReader for R<'_> {
    fn account_data(&self, k: &Pubkey) -> Option<Vec<u8>> { self.0.get_account(k).map(|a| a.data) }
}

fn node_size(f: usize, vs: usize) -> usize {
    (44 + (f + 1) * 32 + (f + 1) * vs).max(44 + (f + 1) * 32 + (f + 2) * 8)
}

fn main() {
    let torna_bytes = std::fs::read("../sbf/out/torna.so").expect("torna.so");
    let ob_bytes = std::fs::read("../orderbook/target/deploy/torna_orderbook.so")
        .expect("torna_orderbook.so (cargo build-sbf in torna/orderbook)");
    let torna = Pubkey::new_unique();
    let orderbook = Pubkey::new_unique();
    let mut svm = LiteSVM::new();
    svm.add_program(torna, &torna_bytes).unwrap();
    svm.add_program(orderbook, &ob_bytes).unwrap();

    let u = Keypair::new(); // market creator / book funder
    svm.airdrop(&u.pubkey(), 1_000_000_000_000).unwrap();
    let ask = Tree::new(torna, u.pubkey(), TID); // the ask book
    let (market_pda, bump) = Pubkey::find_program_address(&[b"book", &MARKET_ID.to_le_bytes()], &orderbook);

    let (mut pass, mut fail) = (0u32, 0u32);
    macro_rules! check { ($c:expr, $m:expr) => {
        if $c { pass += 1; println!("ok   {}", $m); } else { fail += 1; println!("FAIL {}", $m); } }; }
    macro_rules! send { ($signer:expr, $ix:expr) => {{
        let bh = svm.latest_blockhash();
        let tx = Transaction::new(&[$signer], Message::new(&[$ix], Some(&$signer.pubkey())), bh);
        svm.send_transaction(tx).map(|_| ()).map_err(|m| format!("{:?}", m.err))
    }}; }
    macro_rules! resolve { ($b:expr) => {{ let r = R(&svm); $b(&r) }}; }
    macro_rules! send_ret { ($signer:expr, $ix:expr) => {{
        let bh = svm.latest_blockhash();
        let tx = Transaction::new(&[$signer], Message::new(&[$ix], Some(&$signer.pubkey())), bh);
        svm.send_transaction(tx).map(|m| m.return_data.data).map_err(|m| format!("{:?}", m.err))
    }}; }
    // PlaceOrder helper -> the order key
    macro_rules! place_order { ($maker:expr, $price:expr, $size:expr, $nonce:expr) => {{
        let key = keys::order_key(keys::Side::Ask, $price, 0, &$maker.pubkey(), $nonce);
        let path = { let r = R(&svm); ask.path(&r, &key).unwrap() };
        let mut data = vec![0u8, ASK];
        data.extend_from_slice(&($price as u64).to_le_bytes());
        data.extend_from_slice(&($size as u64).to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());          // slot_est
        data.extend_from_slice(&($nonce as u64).to_le_bytes());
        data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
        let mut metas = vec![
            AccountMeta::new($maker.pubkey(), true),
            AccountMeta::new_readonly(market_pda, false),
            AccountMeta::new_readonly(torna, false),
            AccountMeta::new_readonly(ask.header_pda().0, false),
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = ask.node_pda(n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        send!(&$maker, Instruction::new_with_bytes(orderbook, &data, metas)).expect("place");
        key
    }}; }

    let rent = |svm: &LiteSVM, n: usize| svm.minimum_balance_for_rent_exemption(n);
    let order_size = |v: &Option<Vec<u8>>| v.as_ref().map(|x| u64::from_be_bytes(x[32..40].try_into().unwrap()));

    // ---- market setup (client side): init ask book, seed a leaf, hand authority to PDA ----
    send!(&u, ask.init_tree_ix(u.pubkey(), VS, F, rent(&svm, 146), rent(&svm, 32))).expect("init");
    // seed one HIGH-price sentinel ask (cold Insert, while U is still authority) so the
    // book has a leaf; the high price keeps it last so it never interferes with matching
    let seed = keys::order_key(keys::Side::Ask, 1_000_000, 0, &u.pubkey(), 0);
    let seedv = {
        let mut v = vec![0u8; VS as usize]; v[0..32].copy_from_slice(u.pubkey().as_ref()); v
    };
    let ix = resolve!(|r| ask.insert_ix(r, u.pubkey(), &seed, &seedv, rent(&svm, node_size(F as usize, VS as usize))).unwrap());
    send!(&u, ix).expect("seed");
    // transfer the book authority to the market PDA
    let mut d = vec![11u8]; d.extend_from_slice(market_pda.as_ref());
    let ta = Instruction::new_with_bytes(torna, &d,
        vec![AccountMeta::new(ask.header_pda().0, false), AccountMeta::new_readonly(u.pubkey(), true)]);
    send!(&u, ta).expect("transfer authority -> market PDA");
    check!(resolve!(|r| ask.header(r)).map(|h| h.authority) == Some(market_pda), "market authority = PDA");

    // ---- a maker places an ask through the orderbook program ----
    let m = Keypair::new();
    svm.airdrop(&m.pubkey(), 1_000_000_000).unwrap();
    let (price, size, slot_est, nonce) = (100u64, 5u64, 10u64, 1u64);
    let key = keys::order_key(keys::Side::Ask, price, slot_est, &m.pubkey(), nonce);

    let place_ix = |svm: &LiteSVM, signer: &Pubkey| -> Instruction {
        let path = { let r = R(svm); ask.path(&r, &key).unwrap() };
        let mut data = vec![0u8, ASK];
        data.extend_from_slice(&price.to_le_bytes()); data.extend_from_slice(&size.to_le_bytes());
        data.extend_from_slice(&slot_est.to_le_bytes()); data.extend_from_slice(&nonce.to_le_bytes());
        data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
        let mut metas = vec![
            AccountMeta::new(*signer, true),                       // maker (fee payer + signer)
            AccountMeta::new_readonly(market_pda, false),          // book authority (program signs as)
            AccountMeta::new_readonly(torna, false),               // torna program
            AccountMeta::new_readonly(ask.header_pda().0, false),  // header
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = ask.node_pda(n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        Instruction::new_with_bytes(orderbook, &data, metas)
    };
    let ix = place_ix(&svm, &m.pubkey());
    check!(send!(&m, ix).is_ok(), "PlaceOrder via orderbook program succeeds");
    let landed = resolve!(|r| ask.get(r, &key));
    check!(landed.as_deref().map(|v| &v[0..32]) == Some(m.pubkey().as_ref()), "order landed: value.maker = maker");
    check!(landed.as_deref().map(|v| u64::from_be_bytes(v[32..40].try_into().unwrap())) == Some(size), "order landed: value.size correct");

    // ---- a non-owner cannot cancel it ----
    let cancel_ix = |svm: &LiteSVM, signer: &Pubkey| -> Instruction {
        let path = { let r = R(svm); ask.path(&r, &key).unwrap() };
        let mut data = vec![1u8]; data.extend_from_slice(&key);
        data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
        let mut metas = vec![
            AccountMeta::new(*signer, true),
            AccountMeta::new_readonly(market_pda, false),
            AccountMeta::new_readonly(torna, false),
            AccountMeta::new_readonly(ask.header_pda().0, false),
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = ask.node_pda(n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        Instruction::new_with_bytes(orderbook, &data, metas)
    };
    let m2 = Keypair::new();
    svm.airdrop(&m2.pubkey(), 1_000_000_000).unwrap();
    let ix = cancel_ix(&svm, &m2.pubkey());
    check!(send!(&m2, ix).is_err(), "CancelOrder by a non-owner rejected");
    check!(resolve!(|r| ask.get(r, &key)).is_some(), "order still present after rejected cancel");

    // ---- the owner cancels it ----
    let ix = cancel_ix(&svm, &m.pubkey());
    check!(send!(&m, ix).is_ok(), "CancelOrder by the owner succeeds");
    check!(resolve!(|r| ask.get(r, &key)).is_none(), "order removed from the book");

    // ---- matching: a taker sweeps the best asks (full + partial fill) ----
    {
        let (a, b, c) = (Keypair::new(), Keypair::new(), Keypair::new());
        for kp in [&a, &b, &c] { svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap(); }
        let ka = place_order!(a, 100u64, 5u64, 1u64);
        let kb = place_order!(b, 110u64, 8u64, 1u64);
        let kc = place_order!(c, 120u64, 3u64, 1u64);

        // taker BUY: limit 115, size 9 -> fully fills A@100 (5), partially fills B@110 (4)
        let taker = Keypair::new();
        svm.airdrop(&taker.pubkey(), 1_000_000_000).unwrap();
        let path = { let r = R(&svm); ask.path(&r, &ka).unwrap() }; // ka is in the leftmost leaf
        let mut md = vec![2u8, ASK];
        md.extend_from_slice(&115u64.to_le_bytes()); md.extend_from_slice(&9u64.to_le_bytes());
        md.push(16); md.extend_from_slice(&MARKET_ID.to_le_bytes()); md.push(bump);
        let mut metas = vec![
            AccountMeta::new(taker.pubkey(), true),
            AccountMeta::new_readonly(market_pda, false),
            AccountMeta::new_readonly(torna, false),
            AccountMeta::new_readonly(ask.header_pda().0, false),
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = ask.node_pda(n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        let ret = send_ret!(&taker, Instruction::new_with_bytes(orderbook, &md, metas)).expect("match");
        check!(ret[0] == 2, "Match: 2 fills (A full, B partial)");
        check!(&ret[1..33] == a.pubkey().as_ref()
            && u64::from_be_bytes(ret[33..41].try_into().unwrap()) == 100
            && u64::from_be_bytes(ret[41..49].try_into().unwrap()) == 5, "Match fill 0 = A @100 x5 (full)");
        check!(&ret[49..81] == b.pubkey().as_ref()
            && u64::from_be_bytes(ret[81..89].try_into().unwrap()) == 110
            && u64::from_be_bytes(ret[89..97].try_into().unwrap()) == 4, "Match fill 1 = B @110 x4 (partial)");
        // book state after the match
        check!(resolve!(|r| ask.get(r, &ka)).is_none(), "Match: A fully filled -> removed");
        check!(order_size(&resolve!(|r| ask.get(r, &kb))) == Some(4), "Match: B partially filled -> size 8->4");
        check!(order_size(&resolve!(|r| ask.get(r, &kc))) == Some(3), "Match: C above limit -> untouched");
    }

    println!("\nobtest (reference orderbook end to end): pass={pass} fail={fail} -> {}",
             if fail == 0 { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
