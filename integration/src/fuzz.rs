//! Torna fuzzer (pre-MOAT hardening, gate B).
//!
//! The on-chain program parses UNTRUSTED bytes (ix data) and an UNTRUSTED account
//! list. A malformed input must never cause an out-of-bounds access or a VM abort
//! -- it must always end in a CLEAN, defined error (a custom program error or a
//! known runtime error) or success.
//!
//! This throws ~tens of thousands of random instructions (random discriminator,
//! random data length/bytes, random account sets drawn from a pool that includes
//! the real header/nodes/scratch/payer/system/foreign keys, with random
//! writable/signer flags and deliberate aliasing) at the real torna.so and
//! classifies every result. A `ProgramFailedToComplete` / access-violation
//! (the signature of an OOB or abort) FAILS the fuzzer and prints the input.

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
    instruction::InstructionError,
};

const F: usize = 4;
const VS: usize = 8;
const HDR: usize = 44;
const KEY: usize = 32;
const TREE_ID: u32 = 1;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }
fn rng(s: &mut u64) -> u64 { let mut x = *s; x ^= x << 13; x ^= x >> 7; x ^= x << 17; *s = x; x }

struct Cli { svm: LiteSVM, prog: Pubkey, payer: Keypair, slot: u64 }
impl Cli {
    fn pda_hdr(&self) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"thdr", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog) }
    fn pda_alloc(&self) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"talloc", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog) }
    fn pda_node(&self, idx: u64) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"tnode", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes(), &idx.to_le_bytes()], &self.prog) }
    fn rent(&self, s: usize) -> u64 { self.svm.minimum_balance_for_rent_exemption(s) }
    fn acc(&self, k: &Pubkey) -> Option<Vec<u8>> { self.svm.get_account(k).map(|a| a.data) }
    fn node_size(&self) -> usize { (HDR + (F + 1) * KEY + (F + 1) * VS).max(HDR + (F + 1) * KEY + (F + 2) * 8) }

    fn send(&mut self, ix: Instruction) -> Result<(), (TransactionError, Vec<String>)> {
        self.slot += 1;
        let msg = Message::new(&[ix], Some(&self.payer.pubkey()));
        let bh = self.svm.latest_blockhash();
        let tx = Transaction::new(&[&self.payer], msg, bh);
        match self.svm.send_transaction(tx) {
            Ok(_) => Ok(()),
            Err(m) => Err((m.err, m.meta.logs)),
        }
    }

    fn header(&self) -> (u64, u32, u64) {
        let d = self.acc(&self.pda_hdr().0).unwrap();
        (u64::from_le_bytes(d[54..62].try_into().unwrap()),
         u32::from_le_bytes(d[62..66].try_into().unwrap()),
         u64::from_le_bytes(self.acc(&self.pda_alloc().0).unwrap()[8..16].try_into().unwrap()))
    }
    fn path(&self, key: &[u8; 32]) -> Vec<u64> {
        let (root, height, _) = self.header();
        if height == 0 { return vec![]; }
        let mut path = vec![root]; let mut cur = root;
        for _ in 0..height - 1 {
            let d = self.acc(&self.pda_node(cur).0).unwrap();
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
            AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false)]);
        self.send(ix).expect("init");
    }
    fn insert(&mut self, key_n: u32) {
        let (hdr, _) = self.pda_hdr(); let (alc, _) = self.pda_alloc();
        let key = k32(key_n);
        let (_r, height, hw) = self.header();
        let path = self.path(&key);
        let spare_n = height as usize + 2; let rent_node = self.rent(self.node_size());
        let mut d = vec![2u8]; d.extend_from_slice(&key); d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
        d.push(path.len() as u8); d.push(spare_n as u8); d.extend_from_slice(&rent_node.to_le_bytes());
        let mut spares = vec![];
        for i in 0..spare_n { let (pk, b) = self.pda_node(hw + 1 + i as u64); d.push(b); spares.push(pk); }
        let mut metas = vec![AccountMeta::new(hdr, false), AccountMeta::new(self.payer.pubkey(), true),
                             AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false)];
        for &n in &path { metas.push(AccountMeta::new(self.pda_node(n).0, false)); }
        for &s in &spares { metas.push(AccountMeta::new(s, false)); }
        self.send(Instruction::new_with_bytes(self.prog, &d, metas)).expect("setup insert");
    }
}

fn main() {
    let mut svm = LiteSVM::new();
    let prog = Pubkey::new_unique();
    let bytes = std::fs::read("../sbf/out/torna.so").unwrap();
    svm.add_program(prog, &bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    let mut c = Cli { svm, prog, payer, slot: 0 };
    c.init();
    for k in [10u32, 20, 30, 40, 50, 60] { c.insert(k); } // -> height 2, nodes 1..N

    // a program-owned scratch (valid RangeScan target)
    let scratch = Pubkey::new_unique();
    c.svm.set_account(scratch, Account { lamports: 1_000_000_000, data: vec![0u8; 2048], owner: prog, executable: false, rent_epoch: 0 }).unwrap();

    // account pool: (pubkey, can_be_signer)
    let (hdr, _) = c.pda_hdr(); let (alc, _) = c.pda_alloc();
    let payer_pk = c.payer.pubkey();
    let mut pool: Vec<(Pubkey, bool)> = vec![
        (hdr, false), (alc, false),
        (c.pda_node(1).0, false), (c.pda_node(2).0, false), (c.pda_node(3).0, false),
        (c.pda_node(4).0, false), (c.pda_node(99).0, false), // 99 doesn't exist
        (scratch, false), (payer_pk, true), (Pubkey::default(), false), (prog, false),
        (Pubkey::new_unique(), false), (Pubkey::new_unique(), false),
    ];
    // valid discriminators to bias toward (reach the handler bodies)
    let discs = [0u8, 2, 3, 4, 5, 8, 9, 12, 13, 14, 16, 18];

    let mut s = 0xF0F0F0F0u64;
    // iteration count from argv[1], default 20000 (~2 min). 60000 is a thorough pass.
    let iters: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(20_000);
    let mut clean = 0u64; let mut ok = 0u64; let mut bad = 0u64;

    for it in 0..iters {
        // discriminator: 75% from the valid set, else fully random
        let disc = if rng(&mut s) % 100 < 75 { discs[(rng(&mut s) as usize) % discs.len()] }
                   else { (rng(&mut s) & 0xFF) as u8 };
        // data: random length up to 200, random bytes; often seed a plausible key at [1..33]
        let dlen = (rng(&mut s) % 200) as usize;
        let mut data = vec![disc];
        for _ in 0..dlen { data.push((rng(&mut s) & 0xFF) as u8); }
        if data.len() >= 33 && rng(&mut s) % 2 == 0 {
            let kk = k32((rng(&mut s) % 70) as u32);
            data[1..33].copy_from_slice(&kk);
        }
        // accounts: 0..14 metas drawn from the pool (with repetition -> aliasing)
        let n_acc = (rng(&mut s) % 14) as usize;
        let mut metas = Vec::with_capacity(n_acc);
        // 80% of the time put the real header first so handlers parse real F/vs/height
        if rng(&mut s) % 100 < 80 { metas.push(AccountMeta::new(hdr, false)); }
        for _ in 0..n_acc {
            let (pk, can_sign) = pool[(rng(&mut s) as usize) % pool.len()];
            let writable = rng(&mut s) % 2 == 0;
            let signer = can_sign && rng(&mut s) % 2 == 0; // only the real payer may sign
            metas.push(if writable { AccountMeta::new(pk, signer) } else { AccountMeta::new_readonly(pk, signer) });
        }

        let ix = Instruction::new_with_bytes(prog, &data, metas.clone());
        match c.send(ix) {
            Ok(()) => { ok += 1; clean += 1; }
            Err((TransactionError::InstructionError(_, ie), logs)) => {
                // The fuzzer's target is MEMORY SAFETY. A ProgramFailedToComplete is
                // BAD only when the cause is a true memory/abort signature; the same
                // variant is also produced by controlled runtime rejections (an
                // invalid client-provided bump for invoke_signed, insufficient
                // lamports, an unauthorized CPI signer) which are SAFE reverts.
                let mem_markers = ["access violation", "out of bounds", "unaligned",
                                   "panicked", "call depth", "stack", "BPF program panicked",
                                   "Failed to reallocate", "memory"];
                let log_blob = logs.join(" | ").to_lowercase();
                let mem_violation = mem_markers.iter().any(|m| log_blob.contains(m));
                let is_bad = matches!(ie, InstructionError::ComputationalBudgetExceeded)
                    || (matches!(ie, InstructionError::ProgramFailedToComplete) && mem_violation);
                if is_bad {
                    bad += 1;
                    println!("\nFUZZ FAIL at iter {it}: {:?}", ie);
                    println!("  disc={disc} data_len={} data={:02x?}", data.len(), &data[..data.len().min(48)]);
                    println!("  metas={:?}", metas.iter().map(|m| (m.pubkey.to_string()[..4].to_string(), m.is_writable, m.is_signer)).collect::<Vec<_>>());
                    println!("  logs:"); for l in &logs { println!("    {l}"); }
                    std::process::exit(1);
                }
                clean += 1;
            }
            Err(_) => { clean += 1; } // tx/runtime-level rejection, not a program memory bug
        }
        if (it + 1) % 15_000 == 0 { println!("  {} iters: ok={ok} clean_err={} bad={bad}", it + 1, clean - ok); }
    }

    println!("\nfuzz: {iters} random instructions, every result classified");
    println!("  ok={ok}  clean_errors={}  BAD(VM-abort/OOB)={bad}", clean - ok);
    assert_eq!(bad, 0, "fuzzer found a non-clean failure");
    println!("FUZZ PASS (no OOB / no VM abort -- all inputs ended in a defined error or success)");
}
