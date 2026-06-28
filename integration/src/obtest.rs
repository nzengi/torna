//! Reference orderbook end to end WITH token settlement: client (torna-sdk) ->
//! orderbook -> torna-cpi + SPL-Token -> torna engine. Ask makers escrow base into a
//! market vault at PlaceOrder; a buy taker's Match releases base to the taker and pays
//! each maker quote atomically with reducing/removing the order; Cancel refunds. We
//! verify both the book (via the SDK) and the token balances.

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction}, message::Message, pubkey::Pubkey,
    signature::{Keypair, Signer}, transaction::Transaction,
};
use std::str::FromStr;
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
    let ob_bytes = std::fs::read("../orderbook/target/deploy/torna_orderbook.so").expect("torna_orderbook.so");
    let torna = Pubkey::new_unique();
    let orderbook = Pubkey::new_unique();
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
    let mut svm = LiteSVM::new();
    svm.add_program(torna, &torna_bytes).unwrap();
    svm.add_program(orderbook, &ob_bytes).unwrap();

    let u = Keypair::new();
    svm.airdrop(&u.pubkey(), 1_000_000_000_000).unwrap();
    let ask = Tree::new(torna, u.pubkey(), TID);
    let (market_pda, bump) = Pubkey::find_program_address(&[b"book", &MARKET_ID.to_le_bytes()], &orderbook);

    let (mut pass, mut fail) = (0u32, 0u32);
    macro_rules! check { ($c:expr, $m:expr) => {
        if $c { pass += 1; println!("ok   {}", $m); } else { fail += 1; println!("FAIL {}", $m); } }; }
    macro_rules! send { ($signers:expr, $ix:expr) => {{
        let signers = $signers;
        let payer = signers[0].pubkey();
        let bh = svm.latest_blockhash();
        let tx = Transaction::new(&signers, Message::new(&[$ix], Some(&payer)), bh);
        svm.send_transaction(tx).map(|m| m.return_data.data).map_err(|m| format!("{:?}", m.err))
    }}; }
    let rent = |svm: &LiteSVM, n: usize| svm.minimum_balance_for_rent_exemption(n);
    let bal = |svm: &LiteSVM, a: &Pubkey| -> u64 {
        svm.get_account(a).map(|x| u64::from_le_bytes(x.data[64..72].try_into().unwrap())).unwrap_or(0)
    };

    // ---- SPL token helpers (manual ix construction) ----
    let sys_create = |from: &Pubkey, to: &Pubkey, lamports: u64, space: u64, owner: &Pubkey| -> Instruction {
        let mut d = vec![0u8; 4]; d.extend_from_slice(&lamports.to_le_bytes());
        d.extend_from_slice(&space.to_le_bytes()); d.extend_from_slice(owner.as_ref());
        Instruction::new_with_bytes(Pubkey::default(), &d, vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)])
    };
    let init_mint = |mint: &Pubkey, auth: &Pubkey| -> Instruction {
        let mut d = vec![20u8, 0u8]; d.extend_from_slice(auth.as_ref()); d.push(0);
        Instruction::new_with_bytes(token, &d, vec![AccountMeta::new(*mint, false)])
    };
    let init_acct = |acct: &Pubkey, mint: &Pubkey, owner: &Pubkey| -> Instruction {
        let mut d = vec![18u8]; d.extend_from_slice(owner.as_ref());
        Instruction::new_with_bytes(token, &d, vec![AccountMeta::new(*acct, false), AccountMeta::new_readonly(*mint, false)])
    };
    let mint_to = |mint: &Pubkey, dest: &Pubkey, amount: u64| -> Instruction {
        let mut d = vec![7u8]; d.extend_from_slice(&amount.to_le_bytes());
        Instruction::new_with_bytes(token, &d, vec![AccountMeta::new(*mint, false), AccountMeta::new(*dest, false), AccountMeta::new_readonly(u.pubkey(), true)])
    };

    // mints (authority = U); accounts owned/funded by U
    let base_mint = Keypair::new();
    let quote_mint = Keypair::new();
    send!([&u, &base_mint], sys_create(&u.pubkey(), &base_mint.pubkey(), rent(&svm, 82), 82, &token)).unwrap();
    send!([&u], init_mint(&base_mint.pubkey(), &u.pubkey())).unwrap();
    send!([&u, &quote_mint], sys_create(&u.pubkey(), &quote_mint.pubkey(), rent(&svm, 82), 82, &token)).unwrap();
    send!([&u], init_mint(&quote_mint.pubkey(), &u.pubkey())).unwrap();

    // a token account creator: returns the keypair
    let mut mk_acct = |svm: &mut LiteSVM, mint: &Pubkey, owner: &Pubkey| -> Keypair {
        let kp = Keypair::new();
        let bh = svm.latest_blockhash();
        let c = {
            let mut d = vec![0u8; 4]; d.extend_from_slice(&rent(svm, 165).to_le_bytes());
            d.extend_from_slice(&165u64.to_le_bytes()); d.extend_from_slice(token.as_ref());
            Instruction::new_with_bytes(Pubkey::default(), &d, vec![AccountMeta::new(u.pubkey(), true), AccountMeta::new(kp.pubkey(), true)])
        };
        let i = {
            let mut d = vec![18u8]; d.extend_from_slice(owner.as_ref());
            Instruction::new_with_bytes(token, &d, vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(*mint, false)])
        };
        let tx = Transaction::new(&[&u, &kp], Message::new(&[c, i], Some(&u.pubkey())), bh);
        svm.send_transaction(tx).unwrap();
        kp
    };
    let base_vault = mk_acct(&mut svm, &base_mint.pubkey(), &market_pda);
    let a_base = mk_acct(&mut svm, &base_mint.pubkey(), &Pubkey::new_unique()); // placeholder owner; A set below
    let _ = a_base; // re-created per maker below

    // makers A, B and the taker, each with their token accounts
    let (a, b, taker) = (Keypair::new(), Keypair::new(), Keypair::new());
    for kp in [&a, &b, &taker] { svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap(); }
    let a_base = mk_acct(&mut svm, &base_mint.pubkey(), &a.pubkey());
    let a_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &a.pubkey());
    let b_base = mk_acct(&mut svm, &base_mint.pubkey(), &b.pubkey());
    let b_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &b.pubkey());
    let t_base = mk_acct(&mut svm, &base_mint.pubkey(), &taker.pubkey());
    let t_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &taker.pubkey());

    // fund: A has 5 base, B has 8 base, taker has 10000 quote
    send!([&u], mint_to(&base_mint.pubkey(), &a_base.pubkey(), 5)).unwrap();
    send!([&u], mint_to(&base_mint.pubkey(), &b_base.pubkey(), 8)).unwrap();
    send!([&u], mint_to(&quote_mint.pubkey(), &t_quote.pubkey(), 10_000)).unwrap();

    // ---- market setup: ask book, seed a leaf (high sentinel), authority -> market PDA ----
    send!([&u], ask.init_tree_ix(u.pubkey(), VS, F, rent(&svm, 146), rent(&svm, 32))).unwrap();
    let seed = keys::order_key(keys::Side::Ask, 1_000_000, 0, &u.pubkey(), 0);
    let seedv = { let mut v = vec![0u8; VS as usize]; v[0..32].copy_from_slice(u.pubkey().as_ref()); v };
    let ix = { let r = R(&svm); ask.insert_ix(&r, u.pubkey(), &seed, &seedv, rent(&svm, node_size(F as usize, VS as usize))).unwrap() };
    send!([&u], ix).unwrap();
    let mut d = vec![11u8]; d.extend_from_slice(market_pda.as_ref());
    send!([&u], Instruction::new_with_bytes(torna, &d,
        vec![AccountMeta::new(ask.header_pda().0, false), AccountMeta::new_readonly(u.pubkey(), true)])).unwrap();

    // ---- PlaceOrder (escrow base into the vault) ----
    let place = |svm: &mut LiteSVM, maker: &Keypair, maker_base: &Pubkey, price: u64, size: u64, nonce: u64| -> [u8; 32] {
        let key = keys::order_key(keys::Side::Ask, price, 0, &maker.pubkey(), nonce);
        let path = { let r = R(svm); ask.path(&r, &key).unwrap() };
        let mut data = vec![0u8, ASK];
        data.extend_from_slice(&price.to_le_bytes()); data.extend_from_slice(&size.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes()); data.extend_from_slice(&nonce.to_le_bytes());
        data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
        let mut metas = vec![
            AccountMeta::new(maker.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
            AccountMeta::new(*maker_base, false), AccountMeta::new(base_vault.pubkey(), false),
            AccountMeta::new_readonly(token, false),
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = ask.node_pda(n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        let bh = svm.latest_blockhash();
        let tx = Transaction::new(&[maker], Message::new(&[Instruction::new_with_bytes(orderbook, &data, metas)], Some(&maker.pubkey())), bh);
        svm.send_transaction(tx).expect("place");
        key
    };
    let ka = place(&mut svm, &a, &a_base.pubkey(), 100, 5, 1);
    let kb = place(&mut svm, &b, &b_base.pubkey(), 110, 8, 1);
    check!(bal(&svm, &base_vault.pubkey()) == 13, "escrow: vault holds 5+8 base");
    check!(bal(&svm, &a_base.pubkey()) == 0 && bal(&svm, &b_base.pubkey()) == 0, "escrow: makers' base locked");

    // ---- Match: taker buys 9 @ limit 115 -> A full (5), B partial (4); settles tokens ----
    let path = { let r = R(&svm); ask.path(&r, &ka).unwrap() };
    let mut md = vec![2u8, ASK];
    md.extend_from_slice(&115u64.to_le_bytes()); md.extend_from_slice(&9u64.to_le_bytes());
    md.push(2); md.extend_from_slice(&MARKET_ID.to_le_bytes()); md.push(bump); md.push(1); md.push(path.len() as u8);
    let mut metas = vec![
        AccountMeta::new(taker.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
        AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
        AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(t_base.pubkey(), false),
        AccountMeta::new(t_quote.pubkey(), false), AccountMeta::new_readonly(token, false),
        AccountMeta::new(a_quote.pubkey(), false), AccountMeta::new(b_quote.pubkey(), false), // maker_quote[0..2]
    ];
    for (i, &n) in path.iter().enumerate() {
        let pk = ask.node_pda(n).0;
        metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
    }
    let ret = send!([&taker], Instruction::new_with_bytes(orderbook, &md, metas)).expect("match");
    check!(ret[0] == 2, "Match: 2 fills");
    // book state
    check!({ let r = R(&svm); ask.get(&r, &ka).is_none() }, "Match: A removed (full fill)");
    check!({ let r = R(&svm); ask.get(&r, &kb).map(|v| u64::from_be_bytes(v[32..40].try_into().unwrap())) } == Some(4), "Match: B reduced 8->4");
    // token settlement: taker got 9 base, paid 100*5+110*4=940 quote; makers paid in quote
    check!(bal(&svm, &t_base.pubkey()) == 9, "settle: taker received 9 base");
    check!(bal(&svm, &t_quote.pubkey()) == 10_000 - 940, "settle: taker paid 940 quote");
    check!(bal(&svm, &a_quote.pubkey()) == 500, "settle: A received 500 quote (100x5)");
    check!(bal(&svm, &b_quote.pubkey()) == 440, "settle: B received 440 quote (110x4)");
    check!(bal(&svm, &base_vault.pubkey()) == 4, "settle: vault base 13->4");

    // ---- Cancel: B cancels its remaining size 4 -> refund 4 base ----
    let path = { let r = R(&svm); ask.path(&r, &kb).unwrap() };
    let mut data = vec![1u8]; data.extend_from_slice(&kb); data.push(ASK);
    data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
    let mut metas = vec![
        AccountMeta::new(b.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
        AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
        AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(b_base.pubkey(), false),
        AccountMeta::new_readonly(token, false),
    ];
    for (i, &n) in path.iter().enumerate() {
        let pk = ask.node_pda(n).0;
        metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
    }
    send!([&b], Instruction::new_with_bytes(orderbook, &data, metas)).expect("cancel");
    check!({ let r = R(&svm); ask.get(&r, &kb).is_none() }, "Cancel: B's order removed");
    check!(bal(&svm, &b_base.pubkey()) == 4 && bal(&svm, &base_vault.pubkey()) == 0, "refund: 4 base returned to B");

    // ================= BID side: a taker SELL matches the bid book =================
    const BID: u8 = 1;
    let bid = Tree::new(torna, u.pubkey(), 2); // the bid book (tree_id 2, same market PDA)
    let quote_vault = mk_acct(&mut svm, &quote_mint.pubkey(), &market_pda);
    // bid book setup: init, seed a low (worst) bid so it sorts last, authority -> PDA
    send!([&u], bid.init_tree_ix(u.pubkey(), VS, F, rent(&svm, 146), rent(&svm, 32))).unwrap();
    let bseed = keys::order_key(keys::Side::Bid, 1, 0, &u.pubkey(), 0);
    let bseedv = { let mut v = vec![0u8; VS as usize]; v[0..32].copy_from_slice(u.pubkey().as_ref()); v };
    let ix = { let r = R(&svm); bid.insert_ix(&r, u.pubkey(), &bseed, &bseedv, rent(&svm, node_size(F as usize, VS as usize))).unwrap() };
    send!([&u], ix).unwrap();
    let mut d = vec![11u8]; d.extend_from_slice(market_pda.as_ref());
    send!([&u], Instruction::new_with_bytes(torna, &d,
        vec![AccountMeta::new(bid.header_pda().0, false), AccountMeta::new_readonly(u.pubkey(), true)])).unwrap();

    // bid makers C, D + taker2; fund: C 500 quote, D 720 quote, taker2 9 base
    let (c, dd, t2) = (Keypair::new(), Keypair::new(), Keypair::new());
    for kp in [&c, &dd, &t2] { svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap(); }
    let c_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &c.pubkey());
    let c_base = mk_acct(&mut svm, &base_mint.pubkey(), &c.pubkey());
    let d_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &dd.pubkey());
    let d_base = mk_acct(&mut svm, &base_mint.pubkey(), &dd.pubkey());
    let t2_base = mk_acct(&mut svm, &base_mint.pubkey(), &t2.pubkey());
    let t2_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &t2.pubkey());
    send!([&u], mint_to(&quote_mint.pubkey(), &c_quote.pubkey(), 500)).unwrap();
    send!([&u], mint_to(&quote_mint.pubkey(), &d_quote.pubkey(), 720)).unwrap();
    send!([&u], mint_to(&base_mint.pubkey(), &t2_base.pubkey(), 9)).unwrap();

    // place bids (escrow quote = price*size into the quote vault)
    let place_bid = |svm: &mut LiteSVM, maker: &Keypair, src: &Pubkey, price: u64, size: u64, nonce: u64| -> [u8; 32] {
        let key = keys::order_key(keys::Side::Bid, price, 0, &maker.pubkey(), nonce);
        let path = { let r = R(svm); bid.path(&r, &key).unwrap() };
        let mut data = vec![0u8, BID];
        data.extend_from_slice(&price.to_le_bytes()); data.extend_from_slice(&size.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes()); data.extend_from_slice(&nonce.to_le_bytes());
        data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
        let mut metas = vec![
            AccountMeta::new(maker.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(bid.header_pda().0, false),
            AccountMeta::new(*src, false), AccountMeta::new(quote_vault.pubkey(), false),
            AccountMeta::new_readonly(token, false),
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = bid.node_pda(n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        let bh = svm.latest_blockhash();
        let tx = Transaction::new(&[maker], Message::new(&[Instruction::new_with_bytes(orderbook, &data, metas)], Some(&maker.pubkey())), bh);
        svm.send_transaction(tx).expect("place_bid");
        key
    };
    let kc = place_bid(&mut svm, &c, &c_quote.pubkey(), 100, 5, 1);
    let kd = place_bid(&mut svm, &dd, &d_quote.pubkey(), 90, 8, 1);
    check!(bal(&svm, &quote_vault.pubkey()) == 1220, "bid escrow: vault holds 500+720 quote");

    // taker SELL: limit 85, size 9 -> C@100 full (5) + D@90 partial (4); best bid first
    let path = { let r = R(&svm); bid.path(&r, &kc).unwrap() };
    let mut md = vec![2u8, BID];
    md.extend_from_slice(&85u64.to_le_bytes()); md.extend_from_slice(&9u64.to_le_bytes());
    md.push(2); md.extend_from_slice(&MARKET_ID.to_le_bytes()); md.push(bump); md.push(1); md.push(path.len() as u8);
    let mut metas = vec![
        AccountMeta::new(t2.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
        AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(bid.header_pda().0, false),
        AccountMeta::new(quote_vault.pubkey(), false), AccountMeta::new(t2_quote.pubkey(), false),
        AccountMeta::new(t2_base.pubkey(), false), AccountMeta::new_readonly(token, false),
        AccountMeta::new(c_base.pubkey(), false), AccountMeta::new(d_base.pubkey(), false),
    ];
    for (i, &n) in path.iter().enumerate() {
        let pk = bid.node_pda(n).0;
        metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
    }
    let ret = send!([&t2], Instruction::new_with_bytes(orderbook, &md, metas)).expect("match sell");
    check!(ret[0] == 2, "BID Match: 2 fills (C full, D partial)");
    check!({ let r = R(&svm); bid.get(&r, &kc).is_none() }, "BID Match: C removed (full)");
    check!({ let r = R(&svm); bid.get(&r, &kd).map(|v| u64::from_be_bytes(v[32..40].try_into().unwrap())) } == Some(4), "BID Match: D reduced 8->4");
    // settlement (taker sell): taker gave 9 base, received 100*5+90*4=860 quote
    check!(bal(&svm, &t2_base.pubkey()) == 0, "BID settle: taker gave 9 base");
    check!(bal(&svm, &t2_quote.pubkey()) == 860, "BID settle: taker received 860 quote");
    check!(bal(&svm, &c_base.pubkey()) == 5, "BID settle: C received 5 base");
    check!(bal(&svm, &d_base.pubkey()) == 4, "BID settle: D received 4 base");
    check!(bal(&svm, &quote_vault.pubkey()) == 1220 - 860, "BID settle: quote vault 1220->360");

    // ============ PlaceOrderCold: place into a FULL leaf via cold split ============
    {
        const F4: u16 = 4;
        let ns4 = node_size(F4 as usize, VS as usize);
        let ask4 = Tree::new(torna, u.pubkey(), 3); // small-fanout ask book to fill quickly
        // setup: init (F=4), seed a high sentinel, authority -> market PDA (same PDA/vault)
        send!([&u], ask4.init_tree_ix(u.pubkey(), VS, F4, rent(&svm, 146), rent(&svm, 32))).unwrap();
        let s4 = keys::order_key(keys::Side::Ask, 1_000_000, 0, &u.pubkey(), 0);
        let s4v = { let mut v = vec![0u8; VS as usize]; v[0..32].copy_from_slice(u.pubkey().as_ref()); v };
        let ix = { let r = R(&svm); ask4.insert_ix(&r, u.pubkey(), &s4, &s4v, rent(&svm, ns4)).unwrap() };
        send!([&u], ix).unwrap();
        let mut d = vec![11u8]; d.extend_from_slice(market_pda.as_ref());
        send!([&u], Instruction::new_with_bytes(torna, &d,
            vec![AccountMeta::new(ask4.header_pda().0, false), AccountMeta::new_readonly(u.pubkey(), true)])).unwrap();

        // maker E with 4 base to escrow
        let e = Keypair::new(); svm.airdrop(&e.pubkey(), 1_000_000_000).unwrap();
        let e_base = mk_acct(&mut svm, &base_mint.pubkey(), &e.pubkey());
        send!([&u], mint_to(&base_mint.pubkey(), &e_base.pubkey(), 4)).unwrap();

        // PlaceOrder (InsertFast) helper on ask4 -> Result
        let place_hot = |svm: &mut LiteSVM, price: u64, nonce: u64| -> Result<(), String> {
            let key = keys::order_key(keys::Side::Ask, price, 0, &e.pubkey(), nonce);
            let path = { let r = R(svm); ask4.path(&r, &key).unwrap() };
            let mut data = vec![0u8, ASK];
            data.extend_from_slice(&price.to_le_bytes()); data.extend_from_slice(&1u64.to_le_bytes());
            data.extend_from_slice(&0u64.to_le_bytes()); data.extend_from_slice(&nonce.to_le_bytes());
            data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
            let mut metas = vec![
                AccountMeta::new(e.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
                AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask4.header_pda().0, false),
                AccountMeta::new(e_base.pubkey(), false), AccountMeta::new(base_vault.pubkey(), false),
                AccountMeta::new_readonly(token, false),
            ];
            for (i, &n) in path.iter().enumerate() {
                let pk = ask4.node_pda(n).0;
                metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
            }
            let bh = svm.latest_blockhash();
            let tx = Transaction::new(&[&e], Message::new(&[Instruction::new_with_bytes(orderbook, &data, metas)], Some(&e.pubkey())), bh);
            svm.send_transaction(tx).map(|_| ()).map_err(|m| format!("{:?}", m.err))
        };
        // fill the leaf to F=4 (seed@1M + 3 asks); the 4th hot place overflows -> fails
        place_hot(&mut svm, 200, 1).unwrap();
        place_hot(&mut svm, 201, 2).unwrap();
        place_hot(&mut svm, 202, 3).unwrap();
        check!(place_hot(&mut svm, 203, 4).is_err(), "ColdPlace: InsertFast into a full leaf fails");

        // PlaceOrderCold for the overflowing order -> splits and succeeds
        let key = keys::order_key(keys::Side::Ask, 203, 0, &e.pubkey(), 4);
        let (path, spares) = { let r = R(&svm); ask4.cold_plan(&r, &key).unwrap() };
        let mut data = vec![3u8, ASK];
        data.extend_from_slice(&203u64.to_le_bytes()); data.extend_from_slice(&1u64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes()); data.extend_from_slice(&4u64.to_le_bytes());
        data.extend_from_slice(&MARKET_ID.to_le_bytes()); data.push(bump);
        data.push(path.len() as u8); data.push(spares.len() as u8);
        data.extend_from_slice(&rent(&svm, ns4).to_le_bytes());
        for (_, b) in &spares { data.push(*b); }
        let mut metas = vec![
            AccountMeta::new(e.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new(ask4.header_pda().0, false),
            AccountMeta::new(e_base.pubkey(), false), AccountMeta::new(base_vault.pubkey(), false),
            AccountMeta::new_readonly(token, false), AccountMeta::new(ask4.alloc_pda().0, false),
            AccountMeta::new_readonly(Pubkey::default(), false), // system
        ];
        for &n in &path { metas.push(AccountMeta::new(ask4.node_pda(n).0, false)); }
        for (pk, _) in &spares { metas.push(AccountMeta::new(*pk, false)); }
        let vault_before = bal(&svm, &base_vault.pubkey());
        check!(send!([&e], Instruction::new_with_bytes(orderbook, &data, metas)).is_ok(), "ColdPlace: cold Insert (split) via PDA succeeds");
        check!({ let r = R(&svm); ask4.get(&r, &key).is_some() }, "ColdPlace: overflow order landed");
        check!({ let r = R(&svm); ask4.header(&r).map(|h| h.height) } == Some(2), "ColdPlace: tree split (height 1->2)");
        check!(bal(&svm, &base_vault.pubkey()) == vault_before + 1, "ColdPlace: escrow happened");
        // all four E orders present after the split
        let mut all = true;
        for (p, n) in [(200u64, 1u64), (201, 2), (202, 3), (203, 4)] {
            let k = keys::order_key(keys::Side::Ask, p, 0, &e.pubkey(), n);
            if { let r = R(&svm); ask4.get(&r, &k).is_none() } { all = false; }
        }
        check!(all, "ColdPlace: all orders survive the split");

        // ---- MULTI-LEAF match: a taker buy sweeps across BOTH leaves of ask4 ----
        // ask4 now has 2 leaves: {200,201} then {202,203,1M sentinel}. A buy @250 x4
        // fills 200,201 (leaf 0) + 202,203 (leaf 1) -- a cross-leaf sweep.
        let e_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &e.pubkey());
        let taker3 = Keypair::new(); svm.airdrop(&taker3.pubkey(), 1_000_000_000).unwrap();
        let t3_base = mk_acct(&mut svm, &base_mint.pubkey(), &taker3.pubkey());
        let t3_quote = mk_acct(&mut svm, &quote_mint.pubkey(), &taker3.pubkey());
        send!([&u], mint_to(&quote_mint.pubkey(), &t3_quote.pubkey(), 2000)).unwrap();
        let k200 = keys::order_key(keys::Side::Ask, 200, 0, &e.pubkey(), 1);
        let k202 = keys::order_key(keys::Side::Ask, 202, 0, &e.pubkey(), 3);
        let p0 = { let r = R(&svm); ask4.path(&r, &k200).unwrap() }; // [root, leaf0]
        let p1 = { let r = R(&svm); ask4.path(&r, &k202).unwrap() }; // [root, leaf1]
        let v_b4 = bal(&svm, &base_vault.pubkey());
        let mut md = vec![2u8, ASK];
        md.extend_from_slice(&250u64.to_le_bytes()); md.extend_from_slice(&4u64.to_le_bytes());
        md.push(4); md.extend_from_slice(&MARKET_ID.to_le_bytes()); md.push(bump);
        md.push(2); md.push(2); // num_leaves=2, height=2
        let mut metas = vec![
            AccountMeta::new(taker3.pubkey(), true), AccountMeta::new_readonly(market_pda, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask4.header_pda().0, false),
            AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(t3_base.pubkey(), false),
            AccountMeta::new(t3_quote.pubkey(), false), AccountMeta::new_readonly(token, false),
        ];
        for _ in 0..4 { metas.push(AccountMeta::new(e_quote.pubkey(), false)); } // maker_recv[4] (all E)
        for grp in [&p0, &p1] {
            for (i, &n) in grp.iter().enumerate() {
                let pk = ask4.node_pda(n).0;
                metas.push(if i == grp.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
            }
        }
        let ret = send!([&taker3], Instruction::new_with_bytes(orderbook, &md, metas)).expect("multi-leaf match");
        check!(ret[0] == 4, "Multi-leaf: 4 fills across 2 leaves");
        let gone = [(200u64,1u64),(201,2),(202,3),(203,4)].iter()
            .all(|&(p,n)| { let r = R(&svm); ask4.get(&r, &keys::order_key(keys::Side::Ask,p,0,&e.pubkey(),n)).is_none() });
        check!(gone, "Multi-leaf: all 4 swept orders removed");
        check!(bal(&svm, &t3_base.pubkey()) == 4, "Multi-leaf: taker received 4 base");
        check!(bal(&svm, &t3_quote.pubkey()) == 2000 - (200+201+202+203), "Multi-leaf: taker paid 806 quote");
        check!(bal(&svm, &e_quote.pubkey()) == 200+201+202+203, "Multi-leaf: maker E received 806 quote");
        check!(bal(&svm, &base_vault.pubkey()) == v_b4 - 4, "Multi-leaf: vault released 4 base");
    }

    println!("\nobtest (orderbook + token settlement): pass={pass} fail={fail} -> {}",
             if fail == 0 { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
