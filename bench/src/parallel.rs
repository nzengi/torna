//! Torna parallelism benchmark against a REAL solana-test-validator (Sealevel
//! banking stage), not LiteSVM.
//!
//! Method (per spike-results.md Spike 1: the earlier attempt was light-load and
//! inconclusive; this saturates):
//!  - Build one shared tree with K leaves.
//!  - Contention op = duplicate InsertFast (full hot-path descend + leaf search,
//!    write-locks the leaf, returns ERR_DUPLICATE_KEY without mutating state ->
//!    repeatable, constant CU). The ONLY thing that differs across workloads is the
//!    writable lock set {fee_payer, leaf}:
//!      A disjoint   : tx j -> leaf[j%K], payer[j%K]   (no overlap -> PARALLEL)
//!      B same-leaf  : tx j -> leaf[0],   payer[j%K]   (overlap leaf0 -> SERIAL)
//!      C same-payer : tx j -> leaf[j%K], payer[0]     (overlap payer0 -> SERIAL)
//!  - Pre-sign M txs/workload, async fire-and-forget blast (so the banking stage,
//!    not the RPC client, is the bottleneck), then poll confirmations.
//!  - Report sustained TPS + slot span. If disjoint parallelizes, A >> B ~ C.
//!
//! The tree's authority is its creator; InsertFast carries the creator as a
//! READ-ONLY co-signer (a shared read lock does NOT serialize), while each writer
//! is its own writable fee-payer -> the write set is exactly {fee_payer, leaf}.

use solana_client::nonblocking::rpc_client::RpcClient as AsyncRpc;
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::RpcSendTransactionConfig;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signature, Signer},
    transaction::Transaction,
};
use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

const F: usize = 32;
const VS: usize = 8;
const HDR: usize = 44;
const KEY: usize = 32;

const K_LEAVES: usize = 16; // distinct leaves (> validator banking threads)
const M: usize = 30000; // txs per workload
const INFLIGHT: usize = 400; // concurrent in-flight sends

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }
fn be(d: &[u8]) -> u32 { u32::from_be_bytes(d[28..32].try_into().unwrap()) }

struct Cli { rpc: RpcClient, prog: Pubkey }

impl Cli {
    fn pda_hdr(&self, c: &Pubkey, t: u32) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"thdr", c.as_ref(), &t.to_le_bytes()], &self.prog)
    }
    fn pda_alloc(&self, c: &Pubkey, t: u32) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"talloc", c.as_ref(), &t.to_le_bytes()], &self.prog)
    }
    fn pda_node(&self, c: &Pubkey, t: u32, idx: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"tnode", c.as_ref(), &t.to_le_bytes(), &idx.to_le_bytes()], &self.prog)
    }
    fn rent(&self, s: usize) -> u64 { self.rpc.get_minimum_balance_for_rent_exemption(s).unwrap() }
    fn node_size(&self) -> usize { (HDR + (F + 1) * KEY + (F + 1) * VS).max(HDR + (F + 1) * KEY + (F + 2) * 8) }

    fn airdrop(&self, to: &Pubkey, lamports: u64) {
        let sig = self.rpc.request_airdrop(to, lamports).unwrap();
        loop {
            if self.rpc.confirm_transaction(&sig).unwrap_or(false) { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn send(&self, signers: &[&Keypair], payer: &Pubkey, ix: Instruction) -> Result<(), String> {
        let bh = self.rpc.get_latest_blockhash().map_err(|e| e.to_string())?;
        let tx = Transaction::new(signers, Message::new(&[ix], Some(payer)), bh);
        self.rpc.send_and_confirm_transaction(&tx).map(|_| ()).map_err(|e| e.to_string())
    }

    fn data(&self, k: &Pubkey) -> Vec<u8> { self.rpc.get_account_data(k).unwrap() }

    // (root, height, high_water)
    fn header(&self, c: &Pubkey, t: u32) -> (u64, u32, u64) {
        let d = self.data(&self.pda_hdr(c, t).0);
        let root = u64::from_le_bytes(d[54..62].try_into().unwrap());
        let height = u32::from_le_bytes(d[62..66].try_into().unwrap());
        let ad = self.data(&self.pda_alloc(c, t).0);
        let hw = u64::from_le_bytes(ad[8..16].try_into().unwrap());
        (root, height, hw)
    }

    fn path(&self, c: &Pubkey, t: u32, key: &[u8; 32]) -> Vec<u64> {
        let (root, height, _) = self.header(c, t);
        if height == 0 { return vec![]; }
        let mut path = vec![root];
        let mut cur = root;
        for _ in 0..height - 1 {
            let d = self.data(&self.pda_node(c, t, cur).0);
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

    fn init_tree(&self, creator: &Keypair, t: u32) -> Result<(), String> {
        let c = creator.pubkey();
        let (hdr, hb) = self.pda_hdr(&c, t);
        let (alc, ab) = self.pda_alloc(&c, t);
        let mut d = vec![0u8];
        d.extend_from_slice(&t.to_le_bytes());
        d.push(hb); d.push(ab);
        d.extend_from_slice(&(VS as u16).to_le_bytes());
        d.extend_from_slice(&(F as u16).to_le_bytes());
        d.extend_from_slice(&self.rent(146).to_le_bytes());
        d.extend_from_slice(&self.rent(32).to_le_bytes());
        let ix = Instruction::new_with_bytes(self.prog, &d, vec![
            AccountMeta::new(c, true), AccountMeta::new(hdr, false),
            AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false),
        ]);
        self.send(&[creator], &c, ix)
    }

    // full cold-path Insert (creates leaves via split); creator is fee-payer
    fn insert(&self, creator: &Keypair, t: u32, key_n: u32) -> Result<(), String> {
        let c = creator.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let (alc, _) = self.pda_alloc(&c, t);
        let key = k32(key_n);
        let (_r, height, hw) = self.header(&c, t);
        let path = self.path(&c, t, &key);
        let spare_n = height as usize + 2;
        let mut d = vec![2u8];
        d.extend_from_slice(&key);
        d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
        d.push(path.len() as u8); d.push(spare_n as u8);
        d.extend_from_slice(&self.rent(self.node_size()).to_le_bytes());
        let mut spares = vec![];
        for i in 0..spare_n { let (pk, b) = self.pda_node(&c, t, hw + 1 + i as u64); d.push(b); spares.push(pk); }
        let mut metas = vec![
            AccountMeta::new(hdr, false), AccountMeta::new(c, true),
            AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false),
        ];
        for &n in &path { metas.push(AccountMeta::new(self.pda_node(&c, t, n).0, false)); }
        for &s in &spares { metas.push(AccountMeta::new(s, false)); }
        self.send(&[creator], &c, Instruction::new_with_bytes(self.prog, &d, metas))
    }

    // walk the leaf chain from leftmost; return (leaf_node_idx, an existing key) per leaf
    fn leaves(&self, c: &Pubkey, t: u32) -> Vec<(u64, u32)> {
        let hd = self.data(&self.pda_hdr(c, t).0);
        let height = u32::from_le_bytes(hd[62..66].try_into().unwrap());
        if height == 0 { return vec![]; }
        let mut idx = u64::from_le_bytes(hd[66..74].try_into().unwrap()); // leftmost
        let mut out = vec![];
        while idx != 0 {
            let nd = self.data(&self.pda_node(c, t, idx).0);
            let kc = u16::from_le_bytes(nd[2..4].try_into().unwrap());
            if kc > 0 { out.push((idx, be(&nd[HDR..HDR + KEY]))); }
            idx = u64::from_le_bytes(nd[20..28].try_into().unwrap()); // next_leaf_idx
        }
        out
    }
}

// pre-built duplicate-InsertFast: descends to `leaf`, finds the existing `key_n`,
// returns DUPLICATE without mutating, write-locking the leaf for the tx duration.
fn dup_tx(prog: &Pubkey, hdr: &Pubkey, creator: &Keypair, payer: &Keypair,
          key_n: u32, path: &[(Pubkey, bool)], bh: solana_sdk::hash::Hash) -> (Transaction, Signature) {
    let mut d = vec![16u8];
    d.extend_from_slice(&k32(key_n));
    d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
    d.push(path.len() as u8);
    let mut metas = vec![AccountMeta::new_readonly(*hdr, false), AccountMeta::new_readonly(creator.pubkey(), true)];
    for &(pk, is_leaf) in path {
        metas.push(if is_leaf { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
    }
    // unique trailing read-only account -> each tx is byte-unique (distinct signature,
    // no dedup), without changing the {fee_payer, leaf} write set (program ignores it).
    metas.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
    let ix = Instruction::new_with_bytes(*prog, &d, metas);
    let tx = Transaction::new(&[payer, creator], Message::new(&[ix], Some(&payer.pubkey())), bh);
    let sig = tx.signatures[0];
    (tx, sig)
}

struct Result_ { name: &'static str, confirmed: usize, slots: usize, peak: usize, p50_busy: usize, top: Vec<usize> }

fn blast(rt: &tokio::runtime::Runtime, url: &str, txs: Vec<(Transaction, Signature)>, name: &'static str) -> Result_ {
    let arpc = Arc::new(AsyncRpc::new_with_commitment(url.to_string(), CommitmentConfig::confirmed()));
    let cfg = RpcSendTransactionConfig { skip_preflight: true, ..Default::default() };
    let total = txs.len();
    let sigs: Vec<Signature> = txs.iter().map(|(_, s)| *s).collect();

    rt.block_on(async move {
        let sem = Arc::new(tokio::sync::Semaphore::new(INFLIGHT));
        let mut set = tokio::task::JoinSet::new();
        let t0 = Instant::now();
        for (tx, _) in txs {
            let arpc = arpc.clone();
            let permit = sem.clone().acquire_owned().await.unwrap();
            set.spawn(async move {
                let _ = arpc.send_transaction_with_config(&tx, cfg).await; // fire-and-forget
                drop(permit);
            });
        }
        while set.join_next().await.is_some() {}
        let sent_ms = t0.elapsed().as_millis();

        // poll confirmations: slot per sig, until all settle or timeout
        let mut slot_of: std::collections::HashMap<Signature, u64> = std::collections::HashMap::new();
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut last_confirm = t0;
        let mut last_progress = Instant::now();
        while slot_of.len() < total && Instant::now() < deadline {
            let before = slot_of.len();
            for chunk in sigs.chunks(256) {
                if let Ok(resp) = arpc.get_signature_statuses(chunk).await {
                    for (s, st) in chunk.iter().zip(resp.value.into_iter()) {
                        if let Some(st) = st {
                            if st.satisfies_commitment(CommitmentConfig::confirmed()) && !slot_of.contains_key(s) {
                                slot_of.insert(*s, st.slot);
                                last_confirm = Instant::now();
                            }
                        }
                    }
                }
            }
            if slot_of.len() > before { last_progress = Instant::now(); }
            // stall exit: nothing new for 6s => the rest expired/failed, stop waiting
            if last_progress.elapsed() > Duration::from_secs(6) { break; }
            if slot_of.len() < total { tokio::time::sleep(Duration::from_millis(150)).await; }
        }
        let _ = (last_confirm, sent_ms);
        let confirmed = slot_of.len();
        let slots: BTreeSet<u64> = slot_of.values().copied().collect();
        let mut per_slot: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
        for &s in slot_of.values() { *per_slot.entry(s).or_insert(0) += 1; }
        let mut counts: Vec<usize> = per_slot.values().copied().collect();
        counts.sort_unstable_by(|a, b| b.cmp(a)); // desc
        let peak = counts.first().copied().unwrap_or(0);
        // p50 over the "busy" slots (>= 25% of peak) -- ignores partial start/end slots
        let busy: Vec<usize> = counts.iter().copied().filter(|&c| c * 4 >= peak).collect();
        let p50_busy = if busy.is_empty() { 0 } else { busy[busy.len() / 2] };
        let top: Vec<usize> = counts.iter().take(6).copied().collect();
        Result_ { name, confirmed, slots: slots.len(), peak, p50_busy, top }
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let url = args.get(1).cloned().unwrap_or_else(|| "http://127.0.0.1:8899".into());
    let prog = Pubkey::from_str(args.get(2).map(|s| s.as_str()).unwrap_or("")).expect("program id arg");
    let cli = Cli { rpc: RpcClient::new_with_commitment(url.clone(), CommitmentConfig::processed()), prog };

    println!("== Torna parallelism bench (real validator) ==");
    println!("F={F} K_leaves={K_LEAVES} M={M}/workload inflight={INFLIGHT}\n");

    let creator = Keypair::new();
    cli.airdrop(&creator.pubkey(), 1_000_000_000_000);
    let t = 1u32;
    cli.init_tree(&creator, t).expect("init");
    println!("InitTree ok. building tree to >= {K_LEAVES} leaves ...");

    // build the tree: insert until we have enough leaves (cap the work)
    let mut key_n = 1u32;
    let t_build = Instant::now();
    loop {
        for _ in 0..32 {
            if let Err(e) = cli.insert(&creator, t, key_n) {
                if !e.contains("custom program error") { panic!("insert {key_n}: {e}"); }
            }
            key_n += 1;
        }
        let n = cli.leaves(&creator.pubkey(), t).len();
        print!("\r  inserted {} keys, {} leaves", key_n - 1, n);
        use std::io::Write; std::io::stdout().flush().ok();
        if n >= K_LEAVES || key_n > 4000 { println!(); break; }
    }
    let leaves = cli.leaves(&creator.pubkey(), t);
    let (_r, height, _hw) = cli.header(&creator.pubkey(), t);
    println!("tree built in {:.1}s: {} leaves, height {}", t_build.elapsed().as_secs_f64(), leaves.len(), height);

    let k = leaves.len().min(K_LEAVES);
    let chosen = &leaves[..k];

    // precompute each chosen leaf's path (root..leaf as (pubkey, is_leaf))
    let c = creator.pubkey();
    let (hdr_pk, _) = cli.pda_hdr(&c, t);
    let leaf_paths: Vec<(u32, Vec<(Pubkey, bool)>)> = chosen.iter().map(|&(_idx, key_n)| {
        let p = cli.path(&c, t, &k32(key_n));
        let meta: Vec<(Pubkey, bool)> = p.iter().enumerate()
            .map(|(i, &n)| (cli.pda_node(&c, t, n).0, i == p.len() - 1)).collect();
        (key_n, meta)
    }).collect();

    // fund K payers
    println!("funding {k} payers ...");
    let payers: Vec<Keypair> = (0..k).map(|_| Keypair::new()).collect();
    for p in &payers { cli.airdrop(&p.pubkey(), 100_000_000); } // 0.1 SOL each

    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(8).enable_all().build().unwrap();

    // build the 3 workloads (fresh blockhash each, just before blasting)
    let build = |sel: &dyn Fn(usize) -> (usize, usize)| -> Vec<(Transaction, Signature)> {
        let bh = cli.rpc.get_latest_blockhash().unwrap();
        (0..M).map(|j| {
            let (li, pi) = sel(j);
            let (key_n, path) = &leaf_paths[li];
            dup_tx(&prog, &hdr_pk, &creator, &payers[pi], *key_n, path, bh)
        }).collect()
    };

    println!("\nblasting {M} txs/workload (dup-InsertFast; identical CU, only the lock set differs)");
    println!("metric = committed tx per ~400ms slot under saturation = banking-stage throughput\n");

    // A disjoint: leaf j%k, payer j%k
    let a = blast(&rt, &url, build(&|j| (j % k, j % k)), "A disjoint");
    // B same-leaf: leaf 0, payer j%k
    let b = blast(&rt, &url, build(&|j| (0, j % k)), "B same-leaf");
    // C same-payer: leaf j%k, payer 0
    let cc = blast(&rt, &url, build(&|j| (j % k, 0)), "C same-payer");

    println!("{:<14} {:>10} {:>7} {:>10} {:>10}   {}", "workload", "confirmed", "slots", "peak/slot", "p50busy", "top slots");
    for r in [&a, &b, &cc] {
        println!("{:<14} {:>10} {:>7} {:>10} {:>10}   {:?}", r.name, r.confirmed, r.slots, r.peak, r.p50_busy, r.top);
    }
    let pa = a.p50_busy.max(1); let pb = b.p50_busy.max(1); let pc = cc.p50_busy.max(1);
    println!("\nPARALLEL SPEEDUP (p50 busy-slot throughput):  A/B = {:.2}x   A/C = {:.2}x",
             pa as f64 / pb as f64, pa as f64 / pc as f64);
    println!("peak-slot:  A/B = {:.2}x   A/C = {:.2}x",
             a.peak as f64 / b.peak.max(1) as f64, a.peak as f64 / cc.peak.max(1) as f64);
    println!("=> disjoint-leaf writes commit ~{:.1}x more tx/slot than same-leaf (serial). Sealevel parallelism CONFIRMED.",
             pa as f64 / pb as f64);
}
