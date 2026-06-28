//! Composability de-risk (MOAT step 1): a separate program (probe.so) drives Torna
//! InsertFast via CPI, signing as a book-authority PDA. Proves:
//!   1. a PDA-authority program CAN write the book through Torna,
//!   2. a non-authorized direct write FAILS (the authority is really enforced),
//!   3. the proxy ix adds NO shared writable -> writable set stays {fee_payer, leaf},
//!      so disjoint-key place/cancel still parallelize through the program.

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const F: usize = 8;
const VS: usize = 8;
const HDR: usize = 44;
const KEY: usize = 32;
const TID: u32 = 1;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }

struct Env { svm: LiteSVM, torna: Pubkey, probe: Pubkey, rust_probe: Pubkey }

impl Env {
    fn pda_hdr(&self, c: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"thdr", c.as_ref(), &TID.to_le_bytes()], &self.torna)
    }
    fn pda_alloc(&self, c: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"talloc", c.as_ref(), &TID.to_le_bytes()], &self.torna)
    }
    fn pda_node(&self, c: &Pubkey, idx: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"tnode", c.as_ref(), &TID.to_le_bytes(), &idx.to_le_bytes()], &self.torna)
    }
    fn rent(&self, s: usize) -> u64 { self.svm.minimum_balance_for_rent_exemption(s) }
    fn acc(&self, k: &Pubkey) -> Option<Vec<u8>> { self.svm.get_account(k).map(|a| a.data) }
    fn node_size(&self) -> usize { (HDR + (F + 1) * KEY + (F + 1) * VS).max(HDR + (F + 1) * KEY + (F + 2) * 8) }

    fn run(&mut self, payer: &Keypair, ix: Instruction) -> Result<Vec<u8>, String> {
        // no trailing-account trick here: the probe derives its path length from
        // ka_num, so every passed account must be a real one.
        let msg = Message::new(&[ix], Some(&payer.pubkey()));
        let bh = self.svm.latest_blockhash();
        match self.svm.send_transaction(Transaction::new(&[payer], msg, bh)) {
            Ok(m) => Ok(m.return_data.data),
            Err(m) => Err(format!("{:?}", m.err)),
        }
    }

    fn header(&self, c: &Pubkey) -> (u64, u32, u64) {
        let d = self.acc(&self.pda_hdr(c).0).unwrap();
        let root = u64::from_le_bytes(d[54..62].try_into().unwrap());
        let height = u32::from_le_bytes(d[62..66].try_into().unwrap());
        let hw = u64::from_le_bytes(self.acc(&self.pda_alloc(c).0).unwrap()[8..16].try_into().unwrap());
        (root, height, hw)
    }

    fn path(&self, c: &Pubkey, key: &[u8; 32]) -> Vec<u64> {
        let (root, height, _) = self.header(c);
        if height == 0 { return vec![]; }
        let (mut cur, mut p) = (root, vec![root]);
        for _ in 0..height - 1 {
            let d = self.acc(&self.pda_node(c, cur).0).unwrap();
            let cnt = u16::from_le_bytes(d[2..4].try_into().unwrap()) as usize;
            let ko = HDR + (F + 1) * KEY;
            let (mut lo, mut hi) = (0usize, cnt);
            while lo < hi { let m = (lo + hi) / 2;
                if &d[HDR + m * KEY..HDR + m * KEY + KEY] < &key[..] { lo = m + 1; } else { hi = m; } }
            let slot = if lo < cnt && &d[HDR + lo * KEY..HDR + lo * KEY + KEY] == &key[..] { lo + 1 } else { lo };
            cur = u64::from_le_bytes(d[ko + slot * 8..ko + slot * 8 + 8].try_into().unwrap());
            p.push(cur);
        }
        p
    }

    fn init(&mut self, creator: &Keypair) {
        let c = creator.pubkey();
        let (hdr, hb) = self.pda_hdr(&c); let (alc, ab) = self.pda_alloc(&c);
        let mut d = vec![0u8]; d.extend_from_slice(&TID.to_le_bytes()); d.push(hb); d.push(ab);
        d.extend_from_slice(&(VS as u16).to_le_bytes()); d.extend_from_slice(&(F as u16).to_le_bytes());
        d.extend_from_slice(&self.rent(146).to_le_bytes()); d.extend_from_slice(&self.rent(32).to_le_bytes());
        let ix = Instruction::new_with_bytes(self.torna, &d, vec![
            AccountMeta::new(c, true), AccountMeta::new(hdr, false),
            AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false)]);
        self.run(creator, ix).expect("init");
    }

    fn insert(&mut self, creator: &Keypair, key_n: u32) {
        let c = creator.pubkey();
        let (hdr, _) = self.pda_hdr(&c); let (alc, _) = self.pda_alloc(&c);
        let key = k32(key_n);
        let (_r, height, hw) = self.header(&c);
        let path = self.path(&c, &key);
        let spare_n = height as usize + 2;
        let mut d = vec![2u8]; d.extend_from_slice(&key); d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
        d.push(path.len() as u8); d.push(spare_n as u8); d.extend_from_slice(&self.rent(self.node_size()).to_le_bytes());
        let mut spares = vec![];
        for i in 0..spare_n { let (pk, b) = self.pda_node(&c, hw + 1 + i as u64); d.push(b); spares.push(pk); }
        let mut metas = vec![AccountMeta::new(hdr, false), AccountMeta::new(c, true),
                             AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false)];
        for &n in &path { metas.push(AccountMeta::new(self.pda_node(&c, n).0, false)); }
        for &s in &spares { metas.push(AccountMeta::new(s, false)); }
        self.run(creator, Instruction::new_with_bytes(self.torna, &d, metas)).expect("insert");
    }

    // InsertFast account metas [header ro, authority(signer), path (leaf w)] for a key
    fn fast_metas(&self, c: &Pubkey, key_n: u32, authority: Pubkey, auth_signer: bool) -> Vec<AccountMeta> {
        let (hdr, _) = self.pda_hdr(c);
        let path = self.path(c, &k32(key_n));
        let mut metas = vec![
            AccountMeta::new_readonly(hdr, false),
            if auth_signer { AccountMeta::new_readonly(authority, true) } else { AccountMeta::new_readonly(authority, false) },
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = self.pda_node(c, n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        metas
    }
    fn fast_data(&self, key_n: u32, path_len: usize) -> Vec<u8> {
        let mut d = vec![16u8]; d.extend_from_slice(&k32(key_n));
        d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]); d.push(path_len as u8); d
    }

    fn find(&mut self, payer: &Keypair, key_n: u32) -> bool {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c);
        let path = self.path(&c, &k32(key_n));
        let mut d = vec![3u8]; d.extend_from_slice(&k32(key_n)); d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false)];
        for &n in &path { metas.push(AccountMeta::new_readonly(self.pda_node(&c, n).0, false)); }
        match self.run(payer, Instruction::new_with_bytes(self.torna, &d, metas)) {
            Ok(r) => !r.is_empty() && r[0] == 1,
            Err(_) => false,
        }
    }
}

fn main() {
    let torna_bytes = std::fs::read("../sbf/out/torna.so").expect("torna.so (make sbf)");
    let probe_bytes = std::fs::read("../sbf/out/probe.so").expect("probe.so (make probe)");
    let rust_probe_bytes = std::fs::read("../cpi-probe/target/deploy/torna_cpi_probe.so")
        .expect("torna_cpi_probe.so (cargo build-sbf in torna/cpi-probe)");
    let torna = Pubkey::new_unique();
    let probe = Pubkey::new_unique();
    let rust_probe = Pubkey::new_unique();
    let mut svm = LiteSVM::new();
    svm.add_program(torna, &torna_bytes).unwrap();
    svm.add_program(probe, &probe_bytes).unwrap();
    svm.add_program(rust_probe, &rust_probe_bytes).unwrap();
    let mut env = Env { svm, torna, probe, rust_probe };

    let k = Keypair::new();
    env.svm.airdrop(&k.pubkey(), 1_000_000_000_000).unwrap();
    let c = k.pubkey();

    let (mut pass, mut fail) = (0u32, 0u32);
    macro_rules! check { ($cond:expr, $name:expr) => {
        if $cond { pass += 1; println!("ok   {}", $name); } else { fail += 1; println!("FAIL {}", $name); } }; }

    // build a small tree owned by K
    env.init(&k);
    for key_n in [10u32, 20, 30, 40, 50] { env.insert(&k, key_n); }
    check!(env.find(&k, 30), "setup: tree built, key present");

    // transfer the book authority to the probe's PDA
    let (book_pda, bump) = Pubkey::find_program_address(&[b"book"], &probe);
    let (hdr, _) = env.pda_hdr(&c);
    let mut d = vec![11u8]; d.extend_from_slice(book_pda.as_ref());
    let ta = Instruction::new_with_bytes(env.torna, &d,
        vec![AccountMeta::new(hdr, false), AccountMeta::new_readonly(c, true)]);
    env.run(&k, ta).expect("transfer authority -> probe PDA");

    // 2. a direct InsertFast signed by K (no longer the authority) must FAIL
    {
        let path_len = env.path(&c, &k32(25)).len();
        let metas = env.fast_metas(&c, 25, c, true); // K as authority signer (wrong)
        let ix = Instruction::new_with_bytes(env.torna, &env.fast_data(25, path_len), metas);
        check!(env.run(&k, ix).is_err(), "direct InsertFast by ex-authority K rejected");
    }

    // 1+3. ProxyInsertFast via the probe (signs as book PDA) must SUCCEED, and the
    // proxy ix's writable set must be exactly {fee_payer, leaf}.
    {
        let path = env.path(&c, &k32(25));
        let (hdr, _) = env.pda_hdr(&c);
        // probe data = [bump][ InsertFast: 16 | key | value | path_len ]
        let mut d = vec![bump]; d.extend_from_slice(&env.fast_data(25, path.len()));
        // probe accounts: [torna_prog, book_pda, header, ...path(leaf w)]
        let mut metas = vec![
            AccountMeta::new_readonly(env.torna, false),
            AccountMeta::new_readonly(book_pda, false),
            AccountMeta::new_readonly(hdr, false),
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = env.pda_node(&c, n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        // writable-set check (excludes the tx fee-payer, added by run()): only the leaf
        let writable: Vec<&AccountMeta> = metas.iter().filter(|m| m.is_writable).collect();
        let leaf_pk = env.pda_node(&c, *path.last().unwrap()).0;
        check!(writable.len() == 1 && writable[0].pubkey == leaf_pk,
               "proxy ix writable set = {leaf} only (no shared writable; +fee_payer at tx level)");

        let ix = Instruction::new_with_bytes(env.probe, &d, metas);
        check!(env.run(&k, ix).is_ok(), "ProxyInsertFast via book-PDA authority succeeds");
        check!(env.find(&k, 25), "proxied key landed in the book");
    }

    // ---- Rust CPI path: a Rust program (using the torna-cpi crate) drives Torna ----
    {
        let k2 = Keypair::new();
        env.svm.airdrop(&k2.pubkey(), 1_000_000_000_000).unwrap();
        let c2 = k2.pubkey();
        env.init(&k2);
        for key_n in [10u32, 20, 30] { env.insert(&k2, key_n); }
        let (rbook, rbump) = Pubkey::find_program_address(&[b"book"], &env.rust_probe);
        let (hdr2, _) = env.pda_hdr(&c2);
        // transfer the book authority to the Rust probe's ["book"] PDA
        let mut d = vec![11u8]; d.extend_from_slice(rbook.as_ref());
        let ta = Instruction::new_with_bytes(env.torna, &d,
            vec![AccountMeta::new(hdr2, false), AccountMeta::new_readonly(c2, true)]);
        env.run(&k2, ta).expect("transfer to rust book PDA");
        // proxy InsertFast via the Rust probe (torna-cpi insert_fast, signs as ["book"])
        let key_n = 25u32;
        let path = env.path(&c2, &k32(key_n));
        let mut data = vec![rbump]; data.extend_from_slice(&k32(key_n)); data.extend_from_slice(&[0x7Eu8; VS]);
        let mut metas = vec![
            AccountMeta::new_readonly(env.torna, false),
            AccountMeta::new_readonly(rbook, false),
            AccountMeta::new_readonly(hdr2, false),
        ];
        for (i, &n) in path.iter().enumerate() {
            let pk = env.pda_node(&c2, n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        check!(env.run(&k2, Instruction::new_with_bytes(env.rust_probe, &data, metas)).is_ok(),
               "Rust torna-cpi crate: InsertFast via book-PDA authority succeeds");
        check!(env.find(&k2, key_n), "Rust CPI: proxied key landed in the book");
    }

    println!("\ncpitest (composability de-risk): pass={pass} fail={fail} -> {}",
             if fail == 0 { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
