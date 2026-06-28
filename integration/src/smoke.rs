//! Torna v4 SBF smoke test (Increment 4 validation).
//!
//! Loads the real torna.so into LiteSVM, InitTrees a tree (fanout 4 so splits
//! happen fast), inserts keys forcing leaf + internal splits + a root grow, and
//! Finds them back. This is also the first slice of the client PathPlanner: it
//! descends by reading node accounts and supplies spare PDAs for splits.

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const SO: &str = "../sbf/out/torna.so";
const F: usize = 4;
const VS: usize = 8;
const HDR: usize = 44; // NodeHeader size
const KEY: usize = 32;
const TREE_ID: u32 = 7;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }

struct Ctx { svm: LiteSVM, prog: Pubkey, payer: Keypair }

impl Ctx {
    fn hdr_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"thdr", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog)
    }
    fn alloc_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"talloc", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes()], &self.prog)
    }
    fn node_pda(&self, idx: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"tnode", self.payer.pubkey().as_ref(), &TREE_ID.to_le_bytes(), &idx.to_le_bytes()], &self.prog)
    }
    fn rent(&self, space: usize) -> u64 { self.svm.minimum_balance_for_rent_exemption(space) }

    fn send(&mut self, ix: Instruction) -> Result<Vec<u8>, String> {
        let msg = Message::new(&[ix], Some(&self.payer.pubkey()));
        let bh = self.svm.latest_blockhash();
        let tx = Transaction::new(&[&self.payer], msg, bh);
        match self.svm.send_transaction(tx) {
            Ok(m) => Ok(m.return_data.data),
            Err(m) => Err(format!("{:?} | {:?}", m.err, m.meta.logs)),
        }
    }

    fn acc(&self, k: &Pubkey) -> Option<Vec<u8>> { self.svm.get_account(k).map(|a| a.data) }

    // header fields
    fn header(&self) -> (u64, u32, u32) { // (root_idx, height, high_water)
        let (h, _) = self.hdr_pda();
        let d = self.acc(&h).unwrap();
        let root = u64::from_le_bytes(d[54..62].try_into().unwrap());
        let height = u32::from_le_bytes(d[62..66].try_into().unwrap());
        let (a, _) = self.alloc_pda();
        let ad = self.acc(&a).unwrap();
        let hw = u64::from_le_bytes(ad[8..16].try_into().unwrap());
        (root, height, hw as u32)
    }

    // descend root->leaf returning the node_idx path
    fn path(&self, key: &[u8; 32]) -> Vec<u64> {
        let (root, height, _) = self.header();
        if height == 0 { return vec![]; }
        let mut path = vec![root];
        let mut cur = root;
        for _ in 0..height - 1 {
            let (pk, _) = self.node_pda(cur);
            let d = self.acc(&pk).unwrap();
            let cnt = u16::from_le_bytes(d[2..4].try_into().unwrap()) as usize;
            let kids_off = HDR + (F + 1) * KEY;
            // lower_bound
            let mut lo = 0usize; let mut hi = cnt;
            while lo < hi { let mid = (lo + hi) / 2;
                if &d[HDR + mid * KEY..HDR + mid * KEY + KEY] < &key[..] { lo = mid + 1; } else { hi = mid; } }
            let pos = lo;
            let child_slot = if pos < cnt && &d[HDR + pos * KEY..HDR + pos * KEY + KEY] == &key[..] { pos + 1 } else { pos };
            let child = u64::from_le_bytes(d[kids_off + child_slot * 8..kids_off + child_slot * 8 + 8].try_into().unwrap());
            path.push(child);
            cur = child;
        }
        path
    }
}

fn main() {
    let mut svm = LiteSVM::new();
    let prog = Pubkey::new_unique();
    let bytes = std::fs::read(SO).unwrap_or_else(|e| panic!("read {SO}: {e}"));
    svm.add_program(prog, &bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    let mut c = Ctx { svm, prog, payer };

    // ---- InitTree ----
    let (hdr, hb) = c.hdr_pda();
    let (alc, ab) = c.alloc_pda();
    let mut d = vec![0u8];
    d.extend_from_slice(&TREE_ID.to_le_bytes());
    d.push(hb); d.push(ab);
    d.extend_from_slice(&(VS as u16).to_le_bytes());
    d.extend_from_slice(&(F as u16).to_le_bytes());
    d.extend_from_slice(&c.rent(146).to_le_bytes());
    d.extend_from_slice(&c.rent(32).to_le_bytes());
    let sys = Pubkey::default();
    let ix = Instruction::new_with_bytes(c.prog, &d, vec![
        AccountMeta::new(c.payer.pubkey(), true),
        AccountMeta::new(hdr, false),
        AccountMeta::new(alc, false),
        AccountMeta::new_readonly(sys, false),
    ]);
    c.send(ix).expect("init_tree");
    println!("InitTree ok (tree_id={TREE_ID}, F={F}, vs={VS})");

    // node_size for rent
    let leaf_sz = HDR + (F + 1) * KEY + (F + 1) * VS;
    let int_sz = HDR + (F + 1) * KEY + (F + 2) * 8;
    let node_size = leaf_sz.max(int_sz);
    let rent_node = c.rent(node_size);

    // ---- Insert keys 1..=20 (forces leaf splits, internal split, root grow) ----
    let n = 20u32;
    for key_n in 1..=n {
        let key = k32(key_n);
        let (_root, height, hw) = c.header();
        let path = c.path(&key);
        let spare_n = (height as usize) + 2; // generous
        // build ix data
        let mut d = vec![2u8];
        d.extend_from_slice(&key);
        d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]); // value
        d.push(path.len() as u8);
        d.push(spare_n as u8);
        d.extend_from_slice(&rent_node.to_le_bytes());
        // spare bumps
        let mut spare_pdas = vec![];
        for i in 0..spare_n {
            let (pk, bump) = c.node_pda(hw as u64 + 1 + i as u64);
            d.push(bump);
            spare_pdas.push(pk);
        }
        // accounts
        let mut metas = vec![
            AccountMeta::new(hdr, false),
            AccountMeta::new(c.payer.pubkey(), true),
            AccountMeta::new(alc, false),
            AccountMeta::new_readonly(sys, false),
        ];
        for &nidx in &path { metas.push(AccountMeta::new(c.node_pda(nidx).0, false)); }
        for &sp in &spare_pdas { metas.push(AccountMeta::new(sp, false)); }
        let ix = Instruction::new_with_bytes(c.prog, &d, metas);
        c.send(ix).unwrap_or_else(|e| panic!("insert {key_n}: {e}"));
    }
    let (_r, height, hw) = c.header();
    println!("Inserted 1..={n}: height={height}, nodes_allocated={hw}");

    // ---- Find all + a missing key ----
    let mut found = 0;
    for key_n in 1..=n {
        let key = k32(key_n);
        let path = c.path(&key);
        let mut d = vec![3u8];
        d.extend_from_slice(&key);
        d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false)];
        for &nidx in &path { metas.push(AccountMeta::new_readonly(c.node_pda(nidx).0, false)); }
        let ix = Instruction::new_with_bytes(c.prog, &d, metas);
        let ret = c.send(ix).expect("find");
        assert_eq!(ret[0], 1, "key {key_n} must be found");
        assert_eq!(ret[1], (key_n & 0xFF) as u8, "value mismatch for {key_n}");
        found += 1;
    }
    // missing key
    let key = k32(9999);
    let path = c.path(&key);
    let mut d = vec![3u8]; d.extend_from_slice(&key); d.push(path.len() as u8);
    let mut metas = vec![AccountMeta::new_readonly(hdr, false)];
    for &nidx in &path { metas.push(AccountMeta::new_readonly(c.node_pda(nidx).0, false)); }
    let ret = c.send(Instruction::new_with_bytes(c.prog, &d, metas)).expect("find missing");
    assert_eq!(ret[0], 0, "missing key must report not found");

    println!("Find: {found}/{n} found with correct values, missing-key reports absent");

    // ---- RangeScan [5, 15] into a program-owned scratch account ----
    let cap = 32usize;
    let scratch = Pubkey::new_unique();
    c.svm.set_account(scratch, Account {
        lamports: 1_000_000_000, data: vec![0u8; 6 + cap * (KEY + VS)],
        owner: c.prog, executable: false, rent_epoch: 0,
    }).unwrap();
    // next_leaf_idx lives at NodeHeader offset 20
    let next_leaf = |c: &Ctx, idx: u64| -> u64 {
        let d = c.acc(&c.node_pda(idx).0).unwrap();
        u64::from_le_bytes(d[20..28].try_into().unwrap())
    };
    let start_n = 5u32; let end_n = 15u32;
    let skey = k32(start_n);
    let path = c.path(&skey);
    // subsequent chain leaves after the start leaf
    let mut extra = vec![];
    let mut cur = *path.last().unwrap();
    loop {
        let nx = next_leaf(&c, cur);
        if nx == 0 { break; }
        extra.push(nx);
        cur = nx;
        if extra.len() > 32 { break; }
    }
    let mut d = vec![4u8];
    d.extend_from_slice(&skey);
    d.extend_from_slice(&k32(end_n));
    d.push(path.len() as u8);
    d.extend_from_slice(&(cap as u16).to_le_bytes());
    let mut metas = vec![
        AccountMeta::new_readonly(c.hdr_pda().0, false),
        AccountMeta::new(scratch, false),
    ];
    for &nidx in &path { metas.push(AccountMeta::new_readonly(c.node_pda(nidx).0, false)); }
    for &nidx in &extra { metas.push(AccountMeta::new_readonly(c.node_pda(nidx).0, false)); }
    c.send(Instruction::new_with_bytes(c.prog, &d, metas)).expect("range_scan");

    let sd = c.acc(&scratch).unwrap();
    let cnt = u16::from_le_bytes(sd[4..6].try_into().unwrap()) as usize;
    let expected: Vec<u32> = (start_n..=end_n).collect();
    assert_eq!(cnt, expected.len(), "range count");
    for (i, &want) in expected.iter().enumerate() {
        let off = 6 + i * (KEY + VS);
        let got_key = u32::from_be_bytes(sd[off + 28..off + 32].try_into().unwrap());
        let got_val = sd[off + KEY];
        assert_eq!(got_key, want, "range key[{i}]");
        assert_eq!(got_val, (want & 0xFF) as u8, "range value[{i}]");
    }
    println!("RangeScan [5,15]: {cnt} entries, ascending, values correct");

    // ---- Reverse RangeScan: 15 down to 5 (predecessors via next-pointer check) ----
    {
        // build full chain order by walking next from leftmost
        let hd = c.acc(&c.hdr_pda().0).unwrap();
        let leftmost = u64::from_le_bytes(hd[66..74].try_into().unwrap());
        let mut chain = vec![leftmost];
        let mut cur = leftmost;
        loop { let nx = next_leaf(&c, cur); if nx == 0 { break; } chain.push(nx); cur = nx; }
        let rkey_hi = k32(15); let rkey_lo = k32(5);
        let path = c.path(&rkey_hi);
        let start_leaf = *path.last().unwrap();
        let si = chain.iter().position(|&x| x == start_leaf).unwrap();
        let preds: Vec<u64> = chain[..si].iter().rev().copied().collect();

        let scratch2 = Pubkey::new_unique();
        c.svm.set_account(scratch2, Account {
            lamports: 1_000_000_000, data: vec![0u8; 6 + 32 * (KEY + VS)],
            owner: c.prog, executable: false, rent_epoch: 0,
        }).unwrap();
        let mut d = vec![4u8];
        d.extend_from_slice(&rkey_hi);
        d.extend_from_slice(&rkey_lo);
        d.push(path.len() as u8);
        d.extend_from_slice(&32u16.to_le_bytes());
        d.push(1u8); // dir = reverse
        let mut metas = vec![
            AccountMeta::new_readonly(c.hdr_pda().0, false),
            AccountMeta::new(scratch2, false),
        ];
        for &n in &path { metas.push(AccountMeta::new_readonly(c.node_pda(n).0, false)); }
        for &n in &preds { metas.push(AccountMeta::new_readonly(c.node_pda(n).0, false)); }
        c.send(Instruction::new_with_bytes(c.prog, &d, metas)).expect("reverse range");

        let sd = c.acc(&scratch2).unwrap();
        let rc = u16::from_le_bytes(sd[4..6].try_into().unwrap()) as usize;
        let expected: Vec<u32> = (5..=15).rev().collect(); // 15,14,...,5
        assert_eq!(rc, expected.len(), "reverse range count");
        for (i, &want) in expected.iter().enumerate() {
            let off = 6 + i * (KEY + VS);
            let gk = u32::from_be_bytes(sd[off + 28..off + 32].try_into().unwrap());
            assert_eq!(gk, want, "reverse key[{i}]");
        }
        println!("Reverse RangeScan [15..5]: {rc} entries, descending, predecessors verified");
    }
    println!("SMOKE TEST PASS");
}
