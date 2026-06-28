//! Torna EXHAUSTIVE on-chain differential (pre-MOAT hardening, gate A).
//!
//! Drives the REAL torna.so through LiteSVM with a long random insert/delete/find
//! sequence and, after EVERY op, (1) checks the op result against a BTreeMap
//! oracle and (2) reads the entire on-chain tree and re-validates the full set of
//! structural invariants (B1 balance, B3 children=keys+1, B4 occupancy, C1 sorted,
//! C3 subtree key bounds, D1 forward chain) plus in-order == oracle.
//!
//! Unlike the host L2 (which exercises a host driver over node.h), this validates
//! torna.c's OWN wrapper logic: descend, split propagation + CPI spare creation,
//! root grow, bottom-up borrow/merge cascade, CPI close, root collapse, and every
//! header/allocator/chain field update.

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::collections::BTreeMap;

const F: usize = 4;
const VS: usize = 8;
const MIN: usize = F / 2;
const HDR: usize = 44;
const KEY: usize = 32;
const TREE_ID: u32 = 1;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }
fn keynum(b: &[u8]) -> u32 { u32::from_be_bytes(b[28..32].try_into().unwrap()) }

struct Cli { svm: LiteSVM, prog: Pubkey, payer: Keypair, slot: u64 }

impl Cli {
    fn pda_hdr(&self) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"thdr", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog) }
    fn pda_alloc(&self) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"talloc", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog) }
    fn pda_node(&self, idx: u64) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"tnode", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes(), &idx.to_le_bytes()], &self.prog) }
    fn rent(&self, s: usize) -> u64 { self.svm.minimum_balance_for_rent_exemption(s) }
    fn acc(&self, k: &Pubkey) -> Option<Vec<u8>> { self.svm.get_account(k).map(|a| a.data) }
    fn node(&self, idx: u64) -> Vec<u8> { self.acc(&self.pda_node(idx).0).unwrap() }
    fn node_size(&self) -> usize { (HDR + (F + 1) * KEY + (F + 1) * VS).max(HDR + (F + 1) * KEY + (F + 2) * 8) }

    fn run(&mut self, payer: &Keypair, mut ix: Instruction) -> Result<Vec<u8>, String> {
        self.slot += 1;
        ix.accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false)); // unique -> no sig dedup
        let msg = Message::new(&[ix], Some(&payer.pubkey()));
        let bh = self.svm.latest_blockhash();
        let tx = Transaction::new(&[payer], msg, bh);
        match self.svm.send_transaction(tx) {
            Ok(m) => Ok(m.return_data.data),
            Err(m) => Err(format!("{:?}", m.err)),
        }
    }

    // header fields: (root_idx, height, high_water, leftmost)
    fn header(&self) -> (u64, u32, u64, u64) {
        let d = self.acc(&self.pda_hdr().0).unwrap();
        (
            u64::from_le_bytes(d[54..62].try_into().unwrap()),
            u32::from_le_bytes(d[62..66].try_into().unwrap()),
            u64::from_le_bytes(self.acc(&self.pda_alloc().0).unwrap()[8..16].try_into().unwrap()),
            u64::from_le_bytes(d[66..74].try_into().unwrap()),
        )
    }

    fn path(&self, key: &[u8; 32]) -> Vec<u64> {
        let (root, height, _, _) = self.header();
        if height == 0 { return vec![]; }
        let mut path = vec![root];
        let mut cur = root;
        for _ in 0..height - 1 {
            let d = self.node(cur);
            let cnt = u16::from_le_bytes(d[2..4].try_into().unwrap()) as usize;
            let ko = HDR + (F + 1) * KEY;
            let (mut lo, mut hi) = (0usize, cnt);
            while lo < hi { let m = (lo + hi) / 2;
                if &d[HDR + m * KEY..HDR + m * KEY + KEY] < &key[..] { lo = m + 1; } else { hi = m; } }
            let slot = if lo < cnt && &d[HDR + lo * KEY..HDR + lo * KEY + KEY] == &key[..] { lo + 1 } else { lo };
            cur = u64::from_le_bytes(d[ko + slot * 8..ko + slot * 8 + 8].try_into().unwrap());
            path.push(cur);
        }
        path
    }

    fn init(&mut self) {
        let (hdr, hb) = self.pda_hdr(); let (alc, ab) = self.pda_alloc();
        let mut d = vec![0u8]; d.extend_from_slice(&TREE_ID.to_le_bytes()); d.push(hb); d.push(ab);
        d.extend_from_slice(&(VS as u16).to_le_bytes()); d.extend_from_slice(&(F as u16).to_le_bytes());
        d.extend_from_slice(&self.rent(146).to_le_bytes()); d.extend_from_slice(&self.rent(32).to_le_bytes());
        let ix = Instruction::new_with_bytes(self.prog, &d, vec![
            AccountMeta::new(self.payer.pubkey(), true), AccountMeta::new(hdr, false),
            AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false),
        ]);
        let p = self.payer.insecure_clone();
        self.run(&p, ix).expect("init");
    }

    fn insert(&mut self, key_n: u32) -> Result<(), String> {
        let (hdr, _) = self.pda_hdr(); let (alc, _) = self.pda_alloc();
        let key = k32(key_n);
        let (_r, height, hw, _) = self.header();
        let path = self.path(&key);
        let spare_n = height as usize + 2;
        let rent_node = self.rent(self.node_size());
        let mut d = vec![2u8]; d.extend_from_slice(&key); d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
        d.push(path.len() as u8); d.push(spare_n as u8); d.extend_from_slice(&rent_node.to_le_bytes());
        let mut spares = vec![];
        for i in 0..spare_n { let (pk, b) = self.pda_node(hw + 1 + i as u64); d.push(b); spares.push(pk); }
        let mut metas = vec![AccountMeta::new(hdr, false), AccountMeta::new(self.payer.pubkey(), true),
                             AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false)];
        for &n in &path { metas.push(AccountMeta::new(self.pda_node(n).0, false)); }
        for &s in &spares { metas.push(AccountMeta::new(s, false)); }
        let p = self.payer.insecure_clone();
        self.run(&p, Instruction::new_with_bytes(self.prog, &d, metas)).map(|_| ())
    }

    fn delete(&mut self, key_n: u32) -> Result<(), String> {
        let (hdr, _) = self.pda_hdr();
        let key = k32(key_n);
        let path = self.path(&key);
        let height = path.len();
        let mut sides = vec![0u8; height];
        let mut sib_idxs: Vec<u64> = vec![];
        let ko = HDR + (F + 1) * KEY;
        for level in 1..height {
            let node_idx = path[level];
            let pd = self.node(path[level - 1]);
            let pcnt = u16::from_le_bytes(pd[2..4].try_into().unwrap()) as usize;
            let kid = |i: usize| u64::from_le_bytes(pd[ko + i * 8..ko + i * 8 + 8].try_into().unwrap());
            let mut our = 0usize;
            for i in 0..=pcnt { if kid(i) == node_idx { our = i; break; } }
            if our < pcnt { sides[level] = 1; sib_idxs.push(kid(our + 1)); }
            else { sides[level] = 2; sib_idxs.push(kid(our - 1)); }
        }
        let mut d = vec![8u8]; d.extend_from_slice(&key); d.push(height as u8); d.extend_from_slice(&sides);
        let mut metas = vec![AccountMeta::new(hdr, false), AccountMeta::new(self.payer.pubkey(), true)];
        for &n in &path { metas.push(AccountMeta::new(self.pda_node(n).0, false)); }
        for &s in &sib_idxs { metas.push(AccountMeta::new(self.pda_node(s).0, false)); }
        let p = self.payer.insecure_clone();
        self.run(&p, Instruction::new_with_bytes(self.prog, &d, metas)).map(|_| ())
    }

    fn find(&mut self, key_n: u32) -> bool {
        let (hdr, _) = self.pda_hdr();
        let key = k32(key_n);
        let path = self.path(&key);
        let mut d = vec![3u8]; d.extend_from_slice(&key); d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false)];
        for &n in &path { metas.push(AccountMeta::new_readonly(self.pda_node(n).0, false)); }
        let p = self.payer.insecure_clone();
        let r = self.run(&p, Instruction::new_with_bytes(self.prog, &d, metas)).expect("find");
        r[0] == 1
    }

    // ---- full on-chain invariant validation vs oracle ----
    fn validate(&self, oracle: &BTreeMap<u32, u8>, tag: &str) {
        let (root, height, _, leftmost) = self.header();
        if height == 0 {
            assert!(oracle.is_empty(), "[{tag}] empty tree but oracle has {} keys", oracle.len());
            return;
        }
        let mut inorder: Vec<(u32, u8)> = vec![];
        let mut leaf_depth: i64 = -1;
        self.check_rec(root, root, 0, i64::MIN, i64::MAX, &mut inorder, &mut leaf_depth, tag);

        // in-order == oracle (keys and values)
        let want: Vec<(u32, u8)> = oracle.iter().map(|(&k, &v)| (k, v)).collect();
        assert_eq!(inorder.len(), want.len(), "[{tag}] size {} != oracle {}", inorder.len(), want.len());
        for (i, (g, w)) in inorder.iter().zip(want.iter()).enumerate() {
            assert_eq!(g, w, "[{tag}] entry {i}: tree {:?} != oracle {:?}", g, w);
        }

        // forward leaf chain == in-order keys
        let mut walk = leftmost; let mut wi = 0usize; let mut guard = 0;
        loop {
            let d = self.node(walk);
            let cnt = u16::from_le_bytes(d[2..4].try_into().unwrap()) as usize;
            for i in 0..cnt {
                let k = keynum(&d[HDR + i * KEY..HDR + i * KEY + KEY]);
                assert_eq!(k, inorder[wi].0, "[{tag}] chain key mismatch at {wi}");
                wi += 1;
            }
            let next = u64::from_le_bytes(d[20..28].try_into().unwrap());
            if next == 0 { break; }
            walk = next; guard += 1; assert!(guard < 100000, "[{tag}] chain loop");
        }
        assert_eq!(wi, inorder.len(), "[{tag}] chain covers {wi} != {} keys", inorder.len());
    }

    #[allow(clippy::too_many_arguments)]
    fn check_rec(&self, idx: u64, root: u64, depth: i64, low: i64, high: i64,
                 inorder: &mut Vec<(u32, u8)>, leaf_depth: &mut i64, tag: &str) {
        let d = self.node(idx);
        let is_leaf = d[0] == 1;
        let cnt = u16::from_le_bytes(d[2..4].try_into().unwrap()) as usize;
        // B4 occupancy: non-root in [MIN, F]; root <= F
        if idx != root { assert!(cnt >= MIN && cnt <= F, "[{tag}] node {idx} count {cnt} not in [{MIN},{F}]"); }
        else { assert!(cnt <= F, "[{tag}] root count {cnt} > {F}"); }
        // C1 sorted + C3 bounds
        let key_at = |i: usize| keynum(&d[HDR + i * KEY..HDR + i * KEY + KEY]);
        for i in 0..cnt {
            let k = key_at(i) as i64;
            assert!(k >= low && k < high, "[{tag}] node {idx} key {k} outside [{low},{high})");
            if i > 0 { assert!(key_at(i - 1) < key_at(i), "[{tag}] node {idx} not sorted"); }
        }
        if is_leaf {
            if *leaf_depth < 0 { *leaf_depth = depth; }
            assert_eq!(depth, *leaf_depth, "[{tag}] leaf {idx} depth {depth} != {}", *leaf_depth); // B1
            for i in 0..cnt {
                let off = HDR + (F + 1) * KEY + i * VS;
                inorder.push((key_at(i), d[off]));
            }
        } else {
            let ko = HDR + (F + 1) * KEY; // children base (u64 each)
            for i in 0..=cnt { // B3: cnt+1 children
                let child = u64::from_le_bytes(d[ko + i * 8..ko + i * 8 + 8].try_into().unwrap());
                let lo = if i == 0 { low } else { key_at(i - 1) as i64 };
                let hi = if i == cnt { high } else { key_at(i) as i64 };
                self.check_rec(child, root, depth + 1, lo, hi, inorder, leaf_depth, tag);
            }
        }
    }
}

// deterministic xorshift
fn rng(s: &mut u32) -> u32 { let mut x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; *s = x; x }

fn run_seed(bytes: &[u8], seed: u32, nops: usize, kmax: u32) -> (u64, u64, u64, usize, u32) {
    let mut svm = LiteSVM::new();
    let prog = Pubkey::new_unique();
    svm.add_program(prog, bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap(); // 1000 SOL
    let mut c = Cli { svm, prog, payer, slot: 0 };
    c.init();

    let mut oracle: BTreeMap<u32, u8> = BTreeMap::new();
    let mut s = seed;
    let mut n_ins = 0u64; let mut n_del = 0u64; let mut n_find = 0u64;
    let mut max_h = 0u32;

    for it in 0..nops {
        let key = (rng(&mut s) % kmax) + 1;
        let r = rng(&mut s) % 100;
        // bias: grow when small, shrink when large
        let len = oracle.len();
        let do_insert = if len < 25 { r < 75 } else if len > 70 { r < 25 } else { r < 55 };
        let do_find = r >= 90;

        if do_find {
            let got = c.find(key);
            assert_eq!(got, oracle.contains_key(&key), "find({key}) mismatch at op {it}");
            n_find += 1;
        } else if do_insert {
            if oracle.contains_key(&key) {
                assert!(c.insert(key).is_err(), "dup insert({key}) should fail at op {it}");
            } else {
                c.insert(key).unwrap_or_else(|e| panic!("insert({key}) op {it}: {e}"));
                oracle.insert(key, (key & 0xFF) as u8);
                n_ins += 1;
            }
        } else if oracle.contains_key(&key) {
            c.delete(key).unwrap_or_else(|e| panic!("delete({key}) op {it}: {e}"));
            oracle.remove(&key);
            n_del += 1;
        } else {
            assert!(c.delete(key).is_err(), "delete missing({key}) should fail at op {it}");
        }

        let (_r, h, _, _) = c.header();
        if h > max_h { max_h = h; }
        c.validate(&oracle, &format!("seed {seed:#x} op {it}"));
    }
    (n_ins, n_del, n_find, oracle.len(), max_h)
}

fn main() {
    let bytes = std::fs::read("../sbf/out/torna.so").unwrap();
    // multiple seeds -> different random insert/delete interleavings, each fully
    // validated against the oracle + on-chain invariants after every op.
    let seeds = [0x00C0FFEEu32, 0x0BADF00D, 0x12345678, 0xDEADBEEF];
    let nops = 2000usize;
    let kmax = 120u32;
    println!("on-chain differential: {} seeds x {nops} ops, every op validated vs oracle + invariants", seeds.len());
    let mut total_ins = 0u64; let mut total_del = 0u64; let mut total_find = 0u64; let mut gmax_h = 0u32;
    for &seed in &seeds {
        let (i, d, f, live, mh) = run_seed(&bytes, seed, nops, kmax);
        println!("  seed {seed:#010x}: inserts={i} deletes={d} finds={f} live_keys={live} max_height={mh}");
        total_ins += i; total_del += d; total_find += f; if mh > gmax_h { gmax_h = mh; }
    }
    println!("  TOTAL: {} validated ops (ins={total_ins} del={total_del} find={total_find}) max_height={gmax_h}",
             seeds.len() * nops);
    println!("  invariants per op: B1 balance, B3 children=keys+1, B4 occupancy, C1 sorted,");
    println!("                     C3 subtree bounds, D1 forward chain, value equality");
    println!("DIFFTEST PASS");
}
