//! Torna CU-at-scale measurement (pre-MOAT hardening, gate C).
//!
//! Earlier CU numbers were at fanout 4. This crafts production-scale tree states
//! directly (set_account) at F in {16,64,128}, full nodes, and the heaviest hot
//! op (MultiLeaf 8x12), then measures the REAL on-chain compute units of one op
//! and asserts it stays under budget (200k/ix, 1.4M/tx).

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::str::FromStr;

const VS: usize = 8;
const HDR: usize = 44;
const KEY: usize = 32;
const TREE_ID: u32 = 1;
const TORNA_MAGIC: u32 = 0x3454_4254;
const ALLOC_MAGIC: u32 = 0x3443_4c41;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }

struct Crafter { svm: LiteSVM, prog: Pubkey, payer: Keypair, f: usize, slot: u64 }

impl Crafter {
    fn node_size(&self) -> usize {
        let f = self.f;
        (HDR + (f + 1) * KEY + (f + 1) * VS).max(HDR + (f + 1) * KEY + (f + 2) * 8)
    }
    fn pda_hdr(&self) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"thdr", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog) }
    fn pda_alloc(&self) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"talloc", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog) }
    fn pda_node(&self, idx: u64) -> (Pubkey, u8) { Pubkey::find_program_address(&[b"tnode", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes(), &idx.to_le_bytes()], &self.prog) }

    fn set(&mut self, pk: Pubkey, data: Vec<u8>) {
        self.svm.set_account(pk, Account { lamports: 1_000_000_000, data, owner: self.prog, executable: false, rent_epoch: 0 }).unwrap();
    }

    fn write_header(&mut self, root: u64, height: u32, leftmost: u64, rightmost: u64) {
        let mut d = vec![0u8; 146];
        d[0..4].copy_from_slice(&TORNA_MAGIC.to_le_bytes());
        d[4..6].copy_from_slice(&4u16.to_le_bytes());      // version
        d[8..40].copy_from_slice(self.payer.pubkey().as_ref()); // creator
        d[40..44].copy_from_slice(&TREE_ID.to_le_bytes());
        d[44..46].copy_from_slice(&(KEY as u16).to_le_bytes());
        d[46..48].copy_from_slice(&(VS as u16).to_le_bytes());
        d[48..50].copy_from_slice(&(self.f as u16).to_le_bytes());
        d[50..54].copy_from_slice(&(self.node_size() as u32).to_le_bytes());
        d[54..62].copy_from_slice(&root.to_le_bytes());
        d[62..66].copy_from_slice(&height.to_le_bytes());
        d[66..74].copy_from_slice(&leftmost.to_le_bytes());
        d[74..82].copy_from_slice(&rightmost.to_le_bytes());
        d[90..122].copy_from_slice(self.payer.pubkey().as_ref()); // authority
        d[122..138].copy_from_slice(&self.tree_uid()); // 128-bit tenant id
        d[138] = self.pda_alloc().1;                   // alloc_bump
        let pk = self.pda_hdr().0; self.set(pk, d);
    }
    fn write_alloc(&mut self, hw: u64) {
        let mut d = vec![0u8; 32];
        d[0..4].copy_from_slice(&ALLOC_MAGIC.to_le_bytes());
        d[4..8].copy_from_slice(&TREE_ID.to_le_bytes());
        d[8..16].copy_from_slice(&hw.to_le_bytes());
        let pk = self.pda_alloc().0; self.set(pk, d);
    }
    fn tree_uid(&self) -> [u8; 16] {
        let h = solana_sdk::hash::hashv(&[self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()]);
        h.to_bytes()[0..16].try_into().unwrap()
    }
    fn node_hdr_bytes(&self, d: &mut [u8], is_leaf: u8, count: usize, idx: u64, next: u64) {
        d[0] = is_leaf; d[1] = 1;
        d[2..4].copy_from_slice(&(count as u16).to_le_bytes());
        d[8..12].copy_from_slice(&TREE_ID.to_le_bytes());
        d[12..20].copy_from_slice(&idx.to_le_bytes());
        d[20..28].copy_from_slice(&next.to_le_bytes());
        d[28..44].copy_from_slice(&self.tree_uid()); // 128-bit tenant binding
    }
    fn write_leaf(&mut self, idx: u64, keys: &[u32], next: u64, prev: u64) {
        let f = self.f; let mut d = vec![0u8; self.node_size()];
        self.node_hdr_bytes(&mut d, 1, keys.len(), idx, next);
        let voff = HDR + (f + 1) * KEY;
        for (i, &kn) in keys.iter().enumerate() {
            d[HDR + i * KEY..HDR + i * KEY + KEY].copy_from_slice(&k32(kn));
            d[voff + i * VS] = (kn & 0xFF) as u8;
        }
        let pk = self.pda_node(idx).0; self.set(pk, d);
    }
    fn write_internal(&mut self, idx: u64, seps: &[u32], children: &[u64]) {
        let f = self.f; let mut d = vec![0u8; self.node_size()];
        self.node_hdr_bytes(&mut d, 0, seps.len(), idx, 0);
        let coff = HDR + (f + 1) * KEY;
        for (i, &kn) in seps.iter().enumerate() { d[HDR + i * KEY..HDR + i * KEY + KEY].copy_from_slice(&k32(kn)); }
        for (i, &c) in children.iter().enumerate() { d[coff + i * 8..coff + i * 8 + 8].copy_from_slice(&c.to_le_bytes()); }
        let pk = self.pda_node(idx).0; self.set(pk, d);
    }

    fn measure(&mut self, ix: Instruction) -> u64 {
        self.slot += 1;
        // request the max per-tx CU (1.4M) so heavy ops aren't capped at the 200k
        // default; we then check the ACTUAL consumption against the budgets.
        let cb_id = Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
        let mut cb_data = vec![2u8]; cb_data.extend_from_slice(&1_400_000u32.to_le_bytes()); // SetComputeUnitLimit
        let cb = Instruction::new_with_bytes(cb_id, &cb_data, vec![]);
        let msg = Message::new(&[cb, ix], Some(&self.payer.pubkey()));
        let bh = self.svm.latest_blockhash();
        let tx = Transaction::new(&[&self.payer], msg, bh);
        match self.svm.send_transaction(tx) {
            Ok(m) => m.compute_units_consumed,
            Err(m) => panic!("op failed: {:?} | {:?}", m.err, m.meta.logs.last()),
        }
    }
}

fn new_crafter(prog: Pubkey, bytes: &[u8], f: usize) -> Crafter {
    let mut svm = LiteSVM::new();
    svm.add_program(prog, bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    Crafter { svm, prog, payer, f, slot: 0 }
}

const BUDGET_IX_DEFAULT: u64 = 200_000;  // default per-ix; ops above need a CU request
const BUDGET_TX_MAX: u64 = 1_400_000;     // hard per-tx ceiling

fn main() {
    let bytes = std::fs::read("../sbf/out/torna.so").unwrap();
    let prog = Pubkey::new_unique();
    let mut worst = 0u64;
    println!("CU at scale (vs={VS}). default/ix={BUDGET_IX_DEFAULT}, tx cap={BUDGET_TX_MAX}.");
    println!("(ops > default need the client to request a higher CU limit)\n");

    // ---- InsertFast worst-case (front insert into an F-1 leaf) at F=16/64/128 ----
    println!("InsertFast (front insert, full F-1 shift):");
    for &f in &[16usize, 64, 128] {
        let mut c = new_crafter(prog, &bytes, f);
        c.write_header(1, 1, 1, 1); c.write_alloc(1);
        let keys: Vec<u32> = (1..f as u32).map(|i| i * 2).collect(); // F-1 keys, even
        c.write_leaf(1, &keys, 0, 0);
        let (hdr, _) = c.pda_hdr(); let (leaf, _) = c.pda_node(1);
        let mut d = vec![16u8]; d.extend_from_slice(&k32(1)); d.extend_from_slice(&[1u8; VS]); d.push(1u8);
        let cu = c.measure(Instruction::new_with_bytes(prog, &d, vec![
            AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c.payer.pubkey(), true), AccountMeta::new(leaf, false)]));
        println!("  F={f:<4} cu={cu}");
        worst = worst.max(cu);
    }

    // ---- BulkInsertFast: F/2 keys into a slack leaf at F=64 ----
    {
        let f = 64usize;
        let mut c = new_crafter(prog, &bytes, f);
        c.write_header(1, 1, 1, 1); c.write_alloc(1);
        let existing: Vec<u32> = (1..=(f as u32 / 2)).map(|i| 10_000 + i).collect(); // high keys
        c.write_leaf(1, &existing, 0, 0);
        let (hdr, _) = c.pda_hdr(); let (leaf, _) = c.pda_node(1);
        let count = f / 2; // fill to F
        let mut d = vec![9u8, 1u8, count as u8];
        for i in 0..count { d.extend_from_slice(&k32(1 + i as u32)); d.extend_from_slice(&[0u8; VS]); } // low ascending keys
        let cu = c.measure(Instruction::new_with_bytes(prog, &d, vec![
            AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c.payer.pubkey(), true), AccountMeta::new(leaf, false)]));
        println!("\nBulkInsertFast (F/2={count} keys) F={f}: cu={cu}");
        worst = worst.max(cu);
    }

    // ---- Insert with split + root grow (height 1 -> 2), F=64/128 ----
    println!("\nInsert split+rootgrow (full leaf -> split + new root, 2 CPIs):");
    for &f in &[64usize, 128] {
        let mut c = new_crafter(prog, &bytes, f);
        c.write_header(1, 1, 1, 1); c.write_alloc(1);
        let keys: Vec<u32> = (1..=f as u32).map(|i| i * 2).collect(); // full leaf, even keys
        c.write_leaf(1, &keys, 0, 0);
        let (hdr, _) = c.pda_hdr(); let (alc, _) = c.pda_alloc();
        let (leaf, _) = c.pda_node(1); let (sp2, b2) = c.pda_node(2); let (sp3, b3) = c.pda_node(3);
        let rent = c.svm.minimum_balance_for_rent_exemption(c.node_size());
        let mut d = vec![2u8]; d.extend_from_slice(&k32(1)); d.extend_from_slice(&[1u8; VS]); // key=1 (front)
        d.push(1u8); d.push(2u8); d.extend_from_slice(&rent.to_le_bytes()); d.push(b2); d.push(b3);
        let cu = c.measure(Instruction::new_with_bytes(prog, &d, vec![
            AccountMeta::new(hdr, false), AccountMeta::new(c.payer.pubkey(), true), AccountMeta::new(alc, false),
            AccountMeta::new_readonly(Pubkey::default(), false), AccountMeta::new(leaf, false),
            AccountMeta::new(sp2, false), AccountMeta::new(sp3, false)]));
        println!("  F={f:<4} cu={cu}");
        worst = worst.max(cu);
    }

    // ---- MultiLeafInsertFast at MAX (8 leaves x 12 entries), F=64 and 128 ----
    println!("\nMultiLeafInsertFast (8 leaves x 12 entries = 96 inserts):");
    for &f in &[64usize, 128] {
        let mut c = new_crafter(prog, &bytes, f);
        let nleaf = 8u64;
        // leaves 1..8, internal root = 9. leaf i keys = base i*1000 .. +19 (20 keys, slack)
        let root = 9u64;
        c.write_header(root, 2, 1, nleaf); c.write_alloc(9);
        for i in 1..=nleaf {
            let base = i as u32 * 1000;
            let keys: Vec<u32> = (0..20).map(|j| base + j).collect();
            let next = if i < nleaf { i + 1 } else { 0 };
            let prev = if i > 1 { i - 1 } else { 0 };
            c.write_leaf(i, &keys, next, prev);
        }
        let seps: Vec<u32> = (2..=nleaf).map(|i| i as u32 * 1000).collect(); // first key of each right leaf
        let children: Vec<u64> = (1..=nleaf).collect();
        c.write_internal(root, &seps, &children);

        let (hdr, _) = c.pda_hdr();
        let epl = 12u8;
        let mut d = vec![14u8, 2u8, nleaf as u8];
        for _ in 0..nleaf { d.push(epl); }
        for i in 1..=nleaf {
            let base = i as u32 * 1000;
            for j in 0..epl as u32 { d.extend_from_slice(&k32(base + 20 + j)); d.extend_from_slice(&[0u8; VS]); } // ascending, route to leaf i
        }
        let mut metas = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c.payer.pubkey(), true)];
        for i in 1..=nleaf { // each block: [root(ro), leaf_i(w)]
            metas.push(AccountMeta::new_readonly(c.pda_node(root).0, false));
            metas.push(AccountMeta::new(c.pda_node(i).0, false));
        }
        let cu = c.measure(Instruction::new_with_bytes(prog, &d, metas));
        println!("  F={f:<4} cu={cu}  (tx budget 1.4M)");
        worst = worst.max(cu);
    }

    // ---- Delete with merge + root collapse (height 2 -> 1), F=64 ----
    {
        let f = 64usize;
        let mut c = new_crafter(prog, &bytes, f);
        let root = 3u64;
        // leaf1 and leaf2 each at MIN (F/2). delete from leaf1 -> underflow -> merge -> collapse.
        let min = f / 2;
        let l1: Vec<u32> = (1..=min as u32).collect();
        let l2: Vec<u32> = (1000..1000 + min as u32).collect();
        c.write_header(root, 2, 1, 2); c.write_alloc(3);
        c.write_leaf(1, &l1, 2, 0);
        c.write_leaf(2, &l2, 0, 1);
        c.write_internal(root, &[1000], &[1, 2]);
        let (hdr, _) = c.pda_hdr();
        let mut d = vec![8u8]; d.extend_from_slice(&k32(1)); d.push(2u8); d.extend_from_slice(&[0u8, 1u8]); // sides: root=0, leaf=right
        let metas = vec![
            AccountMeta::new(hdr, false), AccountMeta::new(c.payer.pubkey(), true),
            AccountMeta::new(c.pda_node(root).0, false), AccountMeta::new(c.pda_node(1).0, false),
            AccountMeta::new(c.pda_node(2).0, false)];
        let cu = c.measure(Instruction::new_with_bytes(prog, &d, metas));
        println!("\nDelete merge+collapse (height 2->1) F={f}: cu={cu}");
        worst = worst.max(cu);
    }

    println!("\nworst single-ix CU observed: {worst}  (default {BUDGET_IX_DEFAULT}, tx cap {BUDGET_TX_MAX})");
    if worst > BUDGET_IX_DEFAULT {
        println!("NOTE: the heavy ops (Bulk/MultiLeaf) exceed the 200k default -> the");
        println!("client must request a higher CU limit (ComputeBudget) for them.");
    }
    assert!(worst < BUDGET_TX_MAX, "an op exceeded the hard per-tx CU ceiling");
    println!("CU AT SCALE PASS (all ops under the {BUDGET_TX_MAX} tx ceiling)");
}
