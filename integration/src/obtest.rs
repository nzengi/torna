//! Reference orderbook: full flow + TOKEN CONSERVATION + security rejections, against
//! the real engine via LiteSVM. A market = ask tree + bid tree + base/quote vaults +
//! a config (canonical mints/vaults/program/headers), all bound. We assert, after every
//! op: (1) global token conservation (no tokens created/destroyed), (2) escrow backing
//! (base_vault == sum of resting ask sizes; quote_vault == sum of resting bid price*size).
//! Plus: a FAKE-tree / wrong-program match is rejected (the book-binding fix), and
//! wrong-mint / wrong-vault settlement is rejected.

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction}, message::Message, pubkey::Pubkey,
    signature::{Keypair, Signer}, transaction::Transaction,
};
use std::str::FromStr;
use torna_sdk::{keys, AccountReader, Tree};

const VS: u16 = 40; // value = maker(32) + size_be(8)
const F: u16 = 8;   // small fanout -> leaves fill fast (cold-path + multi-leaf reachable)
const MID: u64 = 1;
const ASK: u8 = 0;
const BID: u8 = 1;

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
    let ob = Pubkey::new_unique();
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
    let mut svm = LiteSVM::new();
    svm.add_program(torna, &torna_bytes).unwrap();
    svm.add_program(ob, &ob_bytes).unwrap();

    let u = Keypair::new();
    svm.airdrop(&u.pubkey(), 1_000_000_000_000).unwrap();
    let ask = Tree::new(torna, u.pubkey(), 1);
    let bid = Tree::new(torna, u.pubkey(), 2);
    let (book, bump) = Pubkey::find_program_address(&[b"book", &MID.to_le_bytes()], &ob);
    let (cfg, cfg_bump) = Pubkey::find_program_address(&[b"mkt", &MID.to_le_bytes()], &ob);

    let (mut pass, mut fail) = (0u32, 0u32);
    macro_rules! check { ($c:expr, $m:expr) => {
        if $c { pass += 1; println!("ok   {}", $m); } else { fail += 1; println!("FAIL {}", $m); } }; }
    macro_rules! send { ($signers:expr, $ix:expr) => {{
        let s = $signers; let payer = s[0].pubkey();
        let bh = svm.latest_blockhash();
        svm.send_transaction(Transaction::new(&s, Message::new(&[$ix], Some(&payer)), bh))
            .map(|m| m.return_data.data).map_err(|m| format!("{:?}", m.err))
    }}; }
    let rent = |svm: &LiteSVM, n: usize| svm.minimum_balance_for_rent_exemption(n);
    let bal = |svm: &LiteSVM, a: &Pubkey| svm.get_account(a).map(|x| u64::from_le_bytes(x.data[64..72].try_into().unwrap())).unwrap_or(0);

    // --- SPL helpers (manual ix) ---
    let init_mint = |m: &Pubkey| -> Instruction {
        let mut d = vec![20u8, 0u8]; d.extend_from_slice(u.pubkey().as_ref()); d.push(0);
        Instruction::new_with_bytes(token, &d, vec![AccountMeta::new(*m, false)]) };
    let mint_to = |m: &Pubkey, dst: &Pubkey, amt: u64| -> Instruction {
        let mut d = vec![7u8]; d.extend_from_slice(&amt.to_le_bytes());
        Instruction::new_with_bytes(token, &d, vec![AccountMeta::new(*m, false), AccountMeta::new(*dst, false), AccountMeta::new_readonly(u.pubkey(), true)]) };
    let base_mint = Keypair::new();
    let quote_mint = Keypair::new();
    for mk in [&base_mint, &quote_mint] {
        let mut cd = vec![0u8; 4]; cd.extend_from_slice(&rent(&svm, 82).to_le_bytes());
        cd.extend_from_slice(&82u64.to_le_bytes()); cd.extend_from_slice(token.as_ref());
        send!([&u, mk], Instruction::new_with_bytes(Pubkey::default(), &cd, vec![AccountMeta::new(u.pubkey(), true), AccountMeta::new(mk.pubkey(), true)])).unwrap();
        send!([&u], init_mint(&mk.pubkey())).unwrap();
    }
    let mut mk_acct = |svm: &mut LiteSVM, mint: &Pubkey, owner: &Pubkey| -> Keypair {
        let kp = Keypair::new(); let bh = svm.latest_blockhash();
        let mut cd = vec![0u8; 4]; cd.extend_from_slice(&rent(svm, 165).to_le_bytes());
        cd.extend_from_slice(&165u64.to_le_bytes()); cd.extend_from_slice(token.as_ref());
        let c = Instruction::new_with_bytes(Pubkey::default(), &cd, vec![AccountMeta::new(u.pubkey(), true), AccountMeta::new(kp.pubkey(), true)]);
        let mut id = vec![18u8]; id.extend_from_slice(owner.as_ref());
        let i = Instruction::new_with_bytes(token, &id, vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(*mint, false)]);
        svm.send_transaction(Transaction::new(&[&u, &kp], Message::new(&[c, i], Some(&u.pubkey())), bh)).unwrap();
        kp
    };
    let base_vault = mk_acct(&mut svm, &base_mint.pubkey(), &book);
    let quote_vault = mk_acct(&mut svm, &quote_mint.pubkey(), &book);

    // --- build both trees: init, seed a 0-size sentinel (so escrow==sum holds), authority -> book ---
    let ns = node_size(F as usize, VS as usize);
    for (t, side, p_sent) in [(&ask, keys::Side::Ask, 1_000_000u64), (&bid, keys::Side::Bid, 1u64)] {
        send!([&u], t.init_tree_ix(u.pubkey(), VS, F, rent(&svm, 146), rent(&svm, 32))).unwrap();
        let k = keys::order_key(side, p_sent, 0, &u.pubkey(), 0);
        let mut v = vec![0u8; VS as usize]; v[0..32].copy_from_slice(u.pubkey().as_ref()); // size 0
        let ix = { let r = R(&svm); t.insert_ix(&r, u.pubkey(), &k, &v, rent(&svm, ns)).unwrap() };
        send!([&u], ix).unwrap();
        let mut d = vec![11u8]; d.extend_from_slice(book.as_ref());
        send!([&u], Instruction::new_with_bytes(torna, &d, vec![AccountMeta::new(t.header_pda().0, false), AccountMeta::new_readonly(u.pubkey(), true)])).unwrap();
    }
    // InitMarket (binds mints + vaults + program + both headers)
    {
        let mut d = vec![4u8]; d.extend_from_slice(&MID.to_le_bytes()); d.push(bump); d.push(cfg_bump);
        d.extend_from_slice(&rent(&svm, 229).to_le_bytes());
        let (ar, br) = { let r = R(&svm); (ask.node_pda(ask.header(&r).unwrap().root).0, bid.node_pda(bid.header(&r).unwrap().root).0) };
        send!([&u], Instruction::new_with_bytes(ob, &d, vec![
            AccountMeta::new(u.pubkey(), true), AccountMeta::new(cfg, false), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(base_mint.pubkey(), false), AccountMeta::new_readonly(quote_mint.pubkey(), false),
            AccountMeta::new_readonly(base_vault.pubkey(), false), AccountMeta::new_readonly(quote_vault.pubkey(), false),
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false), AccountMeta::new_readonly(bid.header_pda().0, false),
            AccountMeta::new_readonly(ar, false), AccountMeta::new_readonly(br, false),
        ])).expect("init market");
    }
    check!(svm.get_account(&cfg).map(|a| a.data.len()) == Some(229), "InitMarket wrote the bound config");

    // --- makers + taker, funded; track all token accounts for conservation ---
    let makers: Vec<Keypair> = (0..4).map(|_| Keypair::new()).collect();
    let taker = Keypair::new();
    for kp in makers.iter().chain([&taker]) { svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap(); }
    let mut base_of = std::collections::HashMap::new();
    let mut quote_of = std::collections::HashMap::new();
    for kp in makers.iter().chain([&taker]) {
        base_of.insert(kp.pubkey(), mk_acct(&mut svm, &base_mint.pubkey(), &kp.pubkey()));
        quote_of.insert(kp.pubkey(), mk_acct(&mut svm, &quote_mint.pubkey(), &kp.pubkey()));
        send!([&u], mint_to(&base_mint.pubkey(), &base_of[&kp.pubkey()].pubkey(), 1000)).unwrap();
        send!([&u], mint_to(&quote_mint.pubkey(), &quote_of[&kp.pubkey()].pubkey(), 100_000)).unwrap();
    }
    let all_base: Vec<Pubkey> = base_of.values().map(|k| k.pubkey()).chain([base_vault.pubkey()]).collect();
    let all_quote: Vec<Pubkey> = quote_of.values().map(|k| k.pubkey()).chain([quote_vault.pubkey()]).collect();
    let total = |svm: &LiteSVM, accts: &[Pubkey]| -> u64 { accts.iter().map(|a| bal(svm, a)).sum() };
    let init_base = total(&svm, &all_base);
    let init_quote = total(&svm, &all_quote);

    // conservation + escrow-backing invariants
    macro_rules! invariants { ($label:expr) => {{
        check!(total(&svm, &all_base) == init_base, concat!($label, ": base conserved"));
        check!(total(&svm, &all_quote) == init_quote, concat!($label, ": quote conserved"));
        let r = R(&svm);
        let ask_sum: u64 = ask.scan(&r, 10_000).iter().map(|(_, v)| u64::from_be_bytes(v[32..40].try_into().unwrap())).sum();
        let bid_sum: u64 = bid.scan(&r, 10_000).iter()
            .map(|(k, v)| keys::price_of(keys::Side::Bid, k) * u64::from_be_bytes(v[32..40].try_into().unwrap())).sum();
        check!(bal(&svm, &base_vault.pubkey()) == ask_sum, concat!($label, ": base_vault == sum of resting ask sizes"));
        check!(bal(&svm, &quote_vault.pubkey()) == bid_sum, concat!($label, ": quote_vault == sum of resting bid price*size"));
    }}; }

    // place helper (ASK escrows base from src; BID escrows quote)
    macro_rules! place { ($maker:expr, $side:expr, $price:expr, $size:expr, $nonce:expr) => {{
        let sd = if $side == ASK { keys::Side::Ask } else { keys::Side::Bid };
        let t = if $side == ASK { &ask } else { &bid };
        let src = if $side == ASK { base_of[&$maker.pubkey()].pubkey() } else { quote_of[&$maker.pubkey()].pubkey() };
        let key = keys::order_key(sd, $price, 0, &$maker.pubkey(), $nonce);
        let path = { let r = R(&svm); t.path(&r, &key).unwrap() };
        let mut d = vec![0u8, $side];
        d.extend_from_slice(&($price as u64).to_le_bytes()); d.extend_from_slice(&($size as u64).to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes()); d.extend_from_slice(&($nonce as u64).to_le_bytes());
        d.extend_from_slice(&MID.to_le_bytes()); d.push(bump);
        let vault = if $side == ASK { base_vault.pubkey() } else { quote_vault.pubkey() };
        let mut m = vec![AccountMeta::new($maker.pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(t.header_pda().0, false),
            AccountMeta::new(src, false), AccountMeta::new(vault, false), AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(cfg, false)];
        for (i, &n) in path.iter().enumerate() { let pk = t.node_pda(n).0;
            m.push(if i == path.len()-1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
        send!([&$maker], Instruction::new_with_bytes(ob, &d, m)).map(|_| key)
    }}; }

    // ---- scenario: place asks + bids, then a buy + sell match, then a cancel ----
    let m = &makers;
    place!(m[0], ASK, 100u64, 5u64, 1u64).unwrap();
    place!(m[1], ASK, 110u64, 8u64, 1u64).unwrap();
    place!(m[2], BID, 90u64, 6u64, 1u64).unwrap();
    place!(m[3], BID, 80u64, 4u64, 1u64).unwrap();
    invariants!("after places");

    // buy taker: limit 115, size 9 -> fills 100x5 (m0 full) + 110x4 (m1 partial)
    {
        let path = { let r = R(&svm); ask.path(&r, &keys::order_key(keys::Side::Ask, 100, 0, &m[0].pubkey(), 1)).unwrap() };
        let mut d = vec![2u8, ASK]; d.extend_from_slice(&115u64.to_le_bytes()); d.extend_from_slice(&9u64.to_le_bytes());
        d.push(2); d.extend_from_slice(&MID.to_le_bytes()); d.push(bump); d.push(1); d.push(path.len() as u8);
        let mut meta = vec![AccountMeta::new(taker.pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
            AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(base_of[&taker.pubkey()].pubkey(), false),
            AccountMeta::new(quote_of[&taker.pubkey()].pubkey(), false), AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(cfg, false),
            AccountMeta::new(quote_of[&m[0].pubkey()].pubkey(), false), AccountMeta::new(quote_of[&m[1].pubkey()].pubkey(), false)];
        for (i, &n) in path.iter().enumerate() { let pk = ask.node_pda(n).0;
            meta.push(if i == path.len()-1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
        let ret = send!([&taker], Instruction::new_with_bytes(ob, &d, meta)).expect("buy match");
        check!(ret[0] == 2, "buy match: 2 fills");
    }
    invariants!("after buy match");

    // sell taker: limit 85, size 7 -> fills bid 90x6 (m2 full) + 80x1 (m3 partial)
    {
        let path = { let r = R(&svm); bid.path(&r, &keys::order_key(keys::Side::Bid, 90, 0, &m[2].pubkey(), 1)).unwrap() };
        let mut d = vec![2u8, BID]; d.extend_from_slice(&75u64.to_le_bytes()); d.extend_from_slice(&7u64.to_le_bytes());
        d.push(2); d.extend_from_slice(&MID.to_le_bytes()); d.push(bump); d.push(1); d.push(path.len() as u8);
        let mut meta = vec![AccountMeta::new(taker.pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(bid.header_pda().0, false),
            AccountMeta::new(quote_vault.pubkey(), false), AccountMeta::new(quote_of[&taker.pubkey()].pubkey(), false),
            AccountMeta::new(base_of[&taker.pubkey()].pubkey(), false), AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(cfg, false),
            AccountMeta::new(base_of[&m[2].pubkey()].pubkey(), false), AccountMeta::new(base_of[&m[3].pubkey()].pubkey(), false)];
        for (i, &n) in path.iter().enumerate() { let pk = bid.node_pda(n).0;
            meta.push(if i == path.len()-1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
        let ret = send!([&taker], Instruction::new_with_bytes(ob, &d, meta)).expect("sell match");
        check!(ret[0] == 2, "sell match: 2 fills");
    }
    invariants!("after sell match");

    // cancel m1's remaining ask (110, partially filled to 4) -> refund 4 base
    {
        let key = keys::order_key(keys::Side::Ask, 110, 0, &m[1].pubkey(), 1);
        let path = { let r = R(&svm); ask.path(&r, &key).unwrap() };
        let mut d = vec![1u8]; d.extend_from_slice(&key); d.push(ASK); d.extend_from_slice(&MID.to_le_bytes()); d.push(bump);
        let mut meta = vec![AccountMeta::new(m[1].pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
            AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(base_of[&m[1].pubkey()].pubkey(), false),
            AccountMeta::new_readonly(token, false), AccountMeta::new_readonly(cfg, false)];
        for (i, &n) in path.iter().enumerate() { let pk = ask.node_pda(n).0;
            meta.push(if i == path.len()-1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
        check!(send!([&m[1]], Instruction::new_with_bytes(ob, &d, meta)).is_ok(), "cancel m1's remaining ask");
    }
    invariants!("after cancel");

    // ---- cold-path place (split a full leaf) + multi-leaf match, on the bound ask tree ----
    {
        // fill the leftmost ask leaf to F (sentinel + 7 = 8); prices < sentinel
        for i in 0..7u32 { place!(m[i as usize % 4], ASK, 200 + i as u64, 1u64, 50 + i as u64).unwrap(); }
        invariants!("after filling the ask leaf");
        // the 8th overflows -> PlaceOrderCold (cold Insert via CPI, splits)
        let cold_maker = &m[0];
        let key = keys::order_key(keys::Side::Ask, 207, 0, &cold_maker.pubkey(), 60);
        let (path, spares) = { let r = R(&svm); ask.cold_plan(&r, &key).unwrap() };
        let mut d = vec![3u8, ASK]; d.extend_from_slice(&207u64.to_le_bytes()); d.extend_from_slice(&1u64.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes()); d.extend_from_slice(&60u64.to_le_bytes());
        d.extend_from_slice(&MID.to_le_bytes()); d.push(bump); d.push(path.len() as u8); d.push(spares.len() as u8);
        d.extend_from_slice(&rent(&svm, ns).to_le_bytes());
        for (_, b) in &spares { d.push(*b); }
        let mut meta = vec![AccountMeta::new(cold_maker.pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new(ask.header_pda().0, false),
            AccountMeta::new(base_of[&cold_maker.pubkey()].pubkey(), false), AccountMeta::new(base_vault.pubkey(), false),
            AccountMeta::new_readonly(token, false), AccountMeta::new_readonly(cfg, false),
            AccountMeta::new(ask.alloc_pda().0, false), AccountMeta::new_readonly(Pubkey::default(), false)];
        for &n in &path { meta.push(AccountMeta::new(ask.node_pda(n).0, false)); }
        for (pk, _) in &spares { meta.push(AccountMeta::new(*pk, false)); }
        check!(send!([cold_maker], Instruction::new_with_bytes(ob, &d, meta)).is_ok(), "PlaceOrderCold splits a full leaf");
        check!({ let r = R(&svm); ask.header(&r).map(|h| h.height) } == Some(2), "cold place grew the tree to height 2");
        check!({ let r = R(&svm); ask.get(&r, &key).is_some() }, "cold-placed order landed");
        invariants!("after cold place");

        // multi-leaf buy sweep across both ask leaves (limit 250 covers 200..207)
        let p0 = { let r = R(&svm); ask.path(&r, &keys::order_key(keys::Side::Ask, 200, 0, &m[0].pubkey(), 50)).unwrap() };
        let p1 = { let r = R(&svm); ask.path(&r, &key).unwrap() };
        let mut d = vec![2u8, ASK]; d.extend_from_slice(&250u64.to_le_bytes()); d.extend_from_slice(&8u64.to_le_bytes());
        d.push(8); d.extend_from_slice(&MID.to_le_bytes()); d.push(bump); d.push(2); d.push(p0.len() as u8);
        let mut meta = vec![AccountMeta::new(taker.pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
            AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(base_of[&taker.pubkey()].pubkey(), false),
            AccountMeta::new(quote_of[&taker.pubkey()].pubkey(), false), AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(cfg, false)];
        // 8 maker_recv (quote accts of each filled ask maker, in price order 200..207 -> m0,m1,m2,m3,m0,m1,m2,m0)
        for i in 0..8usize { meta.push(AccountMeta::new(quote_of[&m[[0,1,2,3,0,1,2,0][i]].pubkey()].pubkey(), false)); }
        for grp in [&p0, &p1] { for (i, &n) in grp.iter().enumerate() { let pk = ask.node_pda(n).0;
            meta.push(if i == grp.len()-1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); } }
        let ret = send!([&taker], Instruction::new_with_bytes(ob, &d, meta)).expect("multi-leaf buy");
        check!(ret[0] == 8, "multi-leaf match swept 8 orders across 2 leaves");
        invariants!("after multi-leaf match");
    }

    // ================= SECURITY: the book-binding fix rejects fakery =================
    {
        // a fake "header" (wrong account) for a match -> check_book rejects (CRITICAL fix)
        let fake_header = Pubkey::new_unique();
        let path = { let r = R(&svm); ask.path(&r, &keys::order_key(keys::Side::Ask, 1_000_000, 0, &u.pubkey(), 0)).unwrap() };
        let mut d = vec![2u8, ASK]; d.extend_from_slice(&1_000_000u64.to_le_bytes()); d.extend_from_slice(&1u64.to_le_bytes());
        d.push(1); d.extend_from_slice(&MID.to_le_bytes()); d.push(bump); d.push(1); d.push(path.len() as u8);
        let mk = |hdr: Pubkey, prog: Pubkey| -> Instruction {
            let mut meta = vec![AccountMeta::new(taker.pubkey(), true), AccountMeta::new_readonly(book, false),
                AccountMeta::new_readonly(prog, false), AccountMeta::new_readonly(hdr, false),
                AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(base_of[&taker.pubkey()].pubkey(), false),
                AccountMeta::new(quote_of[&taker.pubkey()].pubkey(), false), AccountMeta::new_readonly(token, false),
                AccountMeta::new_readonly(cfg, false), AccountMeta::new(quote_of[&taker.pubkey()].pubkey(), false)];
            for (i, &n) in path.iter().enumerate() { let pk = ask.node_pda(n).0;
                meta.push(if i == path.len()-1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
            Instruction::new_with_bytes(ob, &d, meta)
        };
        check!(send!([&taker], mk(fake_header, torna)).is_err(), "SECURITY: match with a FAKE header rejected (book-binding)");
        check!(send!([&taker], mk(ask.header_pda().0, Pubkey::new_unique())).is_err(), "SECURITY: match with a WRONG torna program rejected");
        // wrong escrow vault on a place -> rejected
        let key = keys::order_key(keys::Side::Ask, 50, 0, &m[0].pubkey(), 7);
        let pp = { let r = R(&svm); ask.path(&r, &key).unwrap() };
        let mut pd = vec![0u8, ASK]; pd.extend_from_slice(&50u64.to_le_bytes()); pd.extend_from_slice(&1u64.to_le_bytes());
        pd.extend_from_slice(&0u64.to_le_bytes()); pd.extend_from_slice(&7u64.to_le_bytes()); pd.extend_from_slice(&MID.to_le_bytes()); pd.push(bump);
        let mut pm = vec![AccountMeta::new(m[0].pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
            AccountMeta::new(quote_of[&m[0].pubkey()].pubkey(), false), AccountMeta::new(quote_vault.pubkey(), false), // WRONG: quote src+vault for an ask
            AccountMeta::new_readonly(token, false), AccountMeta::new_readonly(cfg, false)];
        for (i, &n) in pp.iter().enumerate() { let pk = ask.node_pda(n).0;
            pm.push(if i == pp.len()-1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
        check!(send!([&m[0]], Instruction::new_with_bytes(ob, &pd, pm)).is_err(), "SECURITY: wrong-mint/vault escrow rejected");
    }
    invariants!("after rejected attacks (state unchanged)");

    // ============ ROUND-2 fixes: InitMarket authority gate + zero-size guard ============
    {
        // zero-size order rejected (matcher fill-slot DoS guard)
        check!(place!(m[0], ASK, 100u64, 0u64, 200u64).is_err(), "SECURITY: zero-size order rejected");
        check!(place!(m[0], ASK, 0u64, 5u64, 201u64).is_err(), "SECURITY: zero-price order rejected");

        // a market whose tree authority is NOT the book PDA is rejected at InitMarket
        let mid2 = 2u64;
        let (book2, _) = Pubkey::find_program_address(&[b"book", &mid2.to_le_bytes()], &ob);
        let (cfg2, _) = Pubkey::find_program_address(&[b"mkt", &mid2.to_le_bytes()], &ob);
        let bv2 = mk_acct(&mut svm, &base_mint.pubkey(), &book2);
        let qv2 = mk_acct(&mut svm, &quote_mint.pubkey(), &book2);
        let ask2 = Tree::new(torna, u.pubkey(), 5);
        let bid2 = Tree::new(torna, u.pubkey(), 6);
        for t in [&ask2, &bid2] { send!([&u], t.init_tree_ix(u.pubkey(), VS, F, rent(&svm, 146), rent(&svm, 32))).unwrap(); }
        let r229 = rent(&svm, 229);
        let init2 = |ah: Pubkey, bh: Pubkey| -> Instruction {
            let mut d = vec![4u8]; d.extend_from_slice(&mid2.to_le_bytes()); d.push(0); d.push(0); // client bumps ignored
            d.extend_from_slice(&r229.to_le_bytes());
            Instruction::new_with_bytes(ob, &d, vec![
                AccountMeta::new(u.pubkey(), true), AccountMeta::new(cfg2, false), AccountMeta::new_readonly(book2, false),
                AccountMeta::new_readonly(base_mint.pubkey(), false), AccountMeta::new_readonly(quote_mint.pubkey(), false),
                AccountMeta::new_readonly(bv2.pubkey(), false), AccountMeta::new_readonly(qv2.pubkey(), false),
                AccountMeta::new_readonly(Pubkey::default(), false),
                AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ah, false), AccountMeta::new_readonly(bh, false),
                AccountMeta::new_readonly(Pubkey::default(), false), AccountMeta::new_readonly(Pubkey::default(), false), // root leaves (empty tree -> unused)
                AccountMeta::new_readonly(Pubkey::new_unique(), false)]) // unique trailing -> distinct tx (no LiteSVM dedup)
        };
        // authority still = creator (not book2) -> rejected (CRITICAL #1: no open/foreign tree)
        check!(send!([&u], init2(ask2.header_pda().0, bid2.header_pda().0)).is_err(), "SECURITY: InitMarket rejects a tree not authority-bound to the book PDA");
        // transfer both to book2, then InitMarket succeeds
        for t in [&ask2, &bid2] { let mut d = vec![11u8]; d.extend_from_slice(book2.as_ref());
            send!([&u], Instruction::new_with_bytes(torna, &d, vec![AccountMeta::new(t.header_pda().0, false), AccountMeta::new_readonly(u.pubkey(), true)])).unwrap(); }
        check!(send!([&u], init2(ask2.header_pda().0, bid2.header_pda().0)).is_ok(), "InitMarket succeeds once authority == book PDA");
        // re-init the same market -> rejected (cfg PDA already exists)
        check!(send!([&u], init2(ask2.header_pda().0, bid2.header_pda().0)).is_err(), "SECURITY: re-InitMarket rejected (cfg exists)");
        // ask_header == bid_header rejected (cross-book price aliasing -- round-3 HIGH)
        check!(send!([&u], init2(ask2.header_pda().0, ask2.header_pda().0)).is_err(), "SECURITY: InitMarket rejects ask_header == bid_header");
    }

    // a tree PRE-SEEDED with a size>0 order is rejected at InitMarket (round-3 #1: no unescrowed orders)
    {
        let mid3 = 3u64;
        let (book3, _) = Pubkey::find_program_address(&[b"book", &mid3.to_le_bytes()], &ob);
        let (cfg3, _) = Pubkey::find_program_address(&[b"mkt", &mid3.to_le_bytes()], &ob);
        let bv3 = mk_acct(&mut svm, &base_mint.pubkey(), &book3);
        let qv3 = mk_acct(&mut svm, &quote_mint.pubkey(), &book3);
        let ask3 = Tree::new(torna, u.pubkey(), 7);
        let bid3 = Tree::new(torna, u.pubkey(), 8);
        for t in [&ask3, &bid3] { send!([&u], t.init_tree_ix(u.pubkey(), VS, F, rent(&svm, 146), rent(&svm, 32))).unwrap(); }
        // attack: creator seeds a SIZE>0 ask with NO escrow, then would transfer + init
        let k = keys::order_key(keys::Side::Ask, 100, 0, &u.pubkey(), 0);
        let mut v = vec![0u8; VS as usize]; v[0..32].copy_from_slice(u.pubkey().as_ref()); v[32..40].copy_from_slice(&7u64.to_be_bytes());
        let ix = { let r = R(&svm); ask3.insert_ix(&r, u.pubkey(), &k, &v, rent(&svm, ns)).unwrap() }; send!([&u], ix).unwrap();
        let ks = keys::order_key(keys::Side::Bid, 1, 0, &u.pubkey(), 0);
        let mut v0 = vec![0u8; VS as usize]; v0[0..32].copy_from_slice(u.pubkey().as_ref());
        let ix2 = { let r = R(&svm); bid3.insert_ix(&r, u.pubkey(), &ks, &v0, rent(&svm, ns)).unwrap() }; send!([&u], ix2).unwrap();
        for t in [&ask3, &bid3] { let mut d = vec![11u8]; d.extend_from_slice(book3.as_ref());
            send!([&u], Instruction::new_with_bytes(torna, &d, vec![AccountMeta::new(t.header_pda().0, false), AccountMeta::new_readonly(u.pubkey(), true)])).unwrap(); }
        let (ar3, br3) = { let r = R(&svm); (ask3.node_pda(ask3.header(&r).unwrap().root).0, bid3.node_pda(bid3.header(&r).unwrap().root).0) };
        let mut d = vec![4u8]; d.extend_from_slice(&mid3.to_le_bytes()); d.push(0); d.push(0); d.extend_from_slice(&rent(&svm, 229).to_le_bytes());
        let m = vec![AccountMeta::new(u.pubkey(), true), AccountMeta::new(cfg3, false), AccountMeta::new_readonly(book3, false),
            AccountMeta::new_readonly(base_mint.pubkey(), false), AccountMeta::new_readonly(quote_mint.pubkey(), false),
            AccountMeta::new_readonly(bv3.pubkey(), false), AccountMeta::new_readonly(qv3.pubkey(), false), AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask3.header_pda().0, false), AccountMeta::new_readonly(bid3.header_pda().0, false),
            AccountMeta::new_readonly(ar3, false), AccountMeta::new_readonly(br3, false)];
        check!(send!([&u], Instruction::new_with_bytes(ob, &d, m)).is_err(), "SECURITY: InitMarket rejects a tree pre-seeded with an unescrowed order");
    }

    // a non-Torna leaf in the match sweep is rejected (round-3 #2: owner-check stops double-settle)
    {
        let p = { let r = R(&svm); ask.path(&r, &keys::order_key(keys::Side::Ask, 1_000_000, 0, &u.pubkey(), 0)).unwrap() };
        let mut d = vec![2u8, ASK]; d.extend_from_slice(&1_000_000u64.to_le_bytes()); d.extend_from_slice(&1u64.to_le_bytes());
        d.push(1); d.extend_from_slice(&MID.to_le_bytes()); d.push(bump); d.push(1); d.push(p.len() as u8);
        let mut m = vec![AccountMeta::new(taker.pubkey(), true), AccountMeta::new_readonly(book, false),
            AccountMeta::new_readonly(torna, false), AccountMeta::new_readonly(ask.header_pda().0, false),
            AccountMeta::new(base_vault.pubkey(), false), AccountMeta::new(base_of[&taker.pubkey()].pubkey(), false),
            AccountMeta::new(quote_of[&taker.pubkey()].pubkey(), false), AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(cfg, false), AccountMeta::new(quote_of[&taker.pubkey()].pubkey(), false)];
        for (i, &n) in p.iter().enumerate() {
            let pk = if i == p.len() - 1 { Pubkey::new_unique() } else { ask.node_pda(n).0 }; // bogus leaf
            m.push(if i == p.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        check!(send!([&taker], Instruction::new_with_bytes(ob, &d, m)).is_err(), "SECURITY: non-Torna leaf in match sweep rejected");
    }

    println!("\nobtest (orderbook: conservation + security): pass={pass} fail={fail} -> {}",
             if fail == 0 { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
