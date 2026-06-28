//! Torna v4 integration + security regression + CU guard (Increment 5).
//!
//! Against the real torna.so in LiteSVM:
//!   - InsertFast / DeleteFast functional round-trips
//!   - Security T1.1 cross-tree splice  -> must fail closed
//!   - Security T2.1 unauthorized write -> must fail closed
//!   - Security T1.3 wrong node in path -> must fail closed
//!   - Security T5.1 truncated ix data  -> must fail closed
//!   - CU regression guard for Insert (split) / InsertFast / Find

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const F: usize = 4;
const VS: usize = 8;
const HDR: usize = 44;
const KEY: usize = 32;

fn k32(n: u32) -> [u8; 32] { let mut k = [0u8; 32]; k[28..32].copy_from_slice(&n.to_be_bytes()); k }

struct Env { svm: LiteSVM, prog: Pubkey, slot: u64 }

impl Env {
    fn pda_hdr(&self, c: &Pubkey, t: u32) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"thdr", c.as_ref(), &t.to_le_bytes()], &self.prog)
    }
    fn pda_alloc(&self, c: &Pubkey, t: u32) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"talloc", c.as_ref(), &t.to_le_bytes()], &self.prog)
    }
    fn pda_node(&self, c: &Pubkey, t: u32, idx: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"tnode", c.as_ref(), &t.to_le_bytes(), &idx.to_le_bytes()], &self.prog)
    }
    fn rent(&self, s: usize) -> u64 { self.svm.minimum_balance_for_rent_exemption(s) }
    fn acc(&self, k: &Pubkey) -> Option<Vec<u8>> { self.svm.get_account(k).map(|a| a.data) }

    fn run(&mut self, payer: &Keypair, mut ix: Instruction) -> Result<(Vec<u8>, u64), String> {
        self.slot += 1;
        // make every tx byte-unique so the signature-dedup cache never rejects an
        // otherwise-identical op (e.g. find(k) before and after a delete). The
        // program ignores trailing accounts beyond the ones it indexes.
        ix.accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
        let msg = Message::new(&[ix], Some(&payer.pubkey()));
        let bh = self.svm.latest_blockhash();
        let tx = Transaction::new(&[payer], msg, bh);
        match self.svm.send_transaction(tx) {
            Ok(m) => Ok((m.return_data.data, m.compute_units_consumed)),
            Err(m) => Err(format!("{:?}", m.err)),
        }
    }

    fn header(&self, c: &Pubkey, t: u32) -> (u64, u32, u32) {
        let d = self.acc(&self.pda_hdr(c, t).0).unwrap();
        let root = u64::from_le_bytes(d[54..62].try_into().unwrap());
        let height = u32::from_le_bytes(d[62..66].try_into().unwrap());
        let ad = self.acc(&self.pda_alloc(c, t).0).unwrap();
        let hw = u64::from_le_bytes(ad[8..16].try_into().unwrap());
        (root, height, hw as u32)
    }

    fn path(&self, c: &Pubkey, t: u32, key: &[u8; 32]) -> Vec<u64> {
        let (root, height, _) = self.header(c, t);
        if height == 0 { return vec![]; }
        let mut path = vec![root];
        let mut cur = root;
        for _ in 0..height - 1 {
            let d = self.acc(&self.pda_node(c, t, cur).0).unwrap();
            let cnt = u16::from_le_bytes(d[2..4].try_into().unwrap()) as usize;
            let kids_off = HDR + (F + 1) * KEY;
            let (mut lo, mut hi) = (0usize, cnt);
            while lo < hi { let mid = (lo + hi) / 2;
                if &d[HDR + mid * KEY..HDR + mid * KEY + KEY] < &key[..] { lo = mid + 1; } else { hi = mid; } }
            let slot = if lo < cnt && &d[HDR + lo * KEY..HDR + lo * KEY + KEY] == &key[..] { lo + 1 } else { lo };
            cur = u64::from_le_bytes(d[kids_off + slot * 8..kids_off + slot * 8 + 8].try_into().unwrap());
            path.push(cur);
        }
        path
    }

    fn init(&mut self, payer: &Keypair, t: u32) {
        let c = payer.pubkey();
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
            AccountMeta::new(c, true),
            AccountMeta::new(hdr, false),
            AccountMeta::new(alc, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
        ]);
        self.run(payer, ix).expect("init");
    }

    fn node_size(&self) -> usize {
        (HDR + (F + 1) * KEY + (F + 1) * VS).max(HDR + (F + 1) * KEY + (F + 2) * 8)
    }

    // full Insert; returns CU
    fn insert(&mut self, payer: &Keypair, t: u32, key_n: u32) -> Result<u64, String> {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let (alc, _) = self.pda_alloc(&c, t);
        let key = k32(key_n);
        let (_r, height, hw) = self.header(&c, t);
        let path = self.path(&c, t, &key);
        let spare_n = height as usize + 2;
        let rent_node = self.rent(self.node_size());
        let mut d = vec![2u8];
        d.extend_from_slice(&key);
        d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
        d.push(path.len() as u8);
        d.push(spare_n as u8);
        d.extend_from_slice(&rent_node.to_le_bytes());
        let mut spares = vec![];
        for i in 0..spare_n { let (pk, b) = self.pda_node(&c, t, hw as u64 + 1 + i as u64); d.push(b); spares.push(pk); }
        let mut metas = vec![
            AccountMeta::new(hdr, false), AccountMeta::new(c, true),
            AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false),
        ];
        for &n in &path { metas.push(AccountMeta::new(self.pda_node(&c, t, n).0, false)); }
        for &s in &spares { metas.push(AccountMeta::new(s, false)); }
        self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|(_, cu)| cu)
    }

    fn insert_fast(&mut self, payer: &Keypair, t: u32, key_n: u32) -> Result<u64, String> {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let key = k32(key_n);
        let path = self.path(&c, t, &key);
        let mut d = vec![16u8];
        d.extend_from_slice(&key);
        d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
        d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c, true)];
        for (i, &n) in path.iter().enumerate() {
            let leaf = i == path.len() - 1;
            let pk = self.pda_node(&c, t, n).0;
            metas.push(if leaf { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|(_, cu)| cu)
    }

    fn delete_fast(&mut self, payer: &Keypair, t: u32, key_n: u32) -> Result<Vec<u8>, String> {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let key = k32(key_n);
        let path = self.path(&c, t, &key);
        let mut d = vec![18u8];
        d.extend_from_slice(&key);
        d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c, true)];
        for (i, &n) in path.iter().enumerate() {
            let leaf = i == path.len() - 1;
            let pk = self.pda_node(&c, t, n).0;
            metas.push(if leaf { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|(r, _)| r)
    }

    // full Delete: computes sibling sides + sibling accounts (right-preferred,
    // matching the program), one per non-root level.
    fn delete(&mut self, payer: &Keypair, t: u32, key_n: u32) -> Result<u64, String> {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let key = k32(key_n);
        let path = self.path(&c, t, &key);
        let height = path.len();
        let mut sides = vec![0u8; height];
        let mut sib_idxs: Vec<u64> = vec![];
        let kids_off = HDR + (F + 1) * KEY;
        for level in 1..height {
            let node_idx = path[level];
            let pd = self.acc(&self.pda_node(&c, t, path[level - 1]).0).unwrap();
            let pcnt = u16::from_le_bytes(pd[2..4].try_into().unwrap()) as usize;
            let kid = |i: usize| u64::from_le_bytes(pd[kids_off + i * 8..kids_off + i * 8 + 8].try_into().unwrap());
            let mut our = 0usize;
            for i in 0..=pcnt { if kid(i) == node_idx { our = i; break; } }
            if our < pcnt { sides[level] = 1; sib_idxs.push(kid(our + 1)); }
            else { sides[level] = 2; sib_idxs.push(kid(our - 1)); }
        }
        let mut d = vec![8u8];
        d.extend_from_slice(&key);
        d.push(height as u8);
        d.extend_from_slice(&sides);
        let mut metas = vec![AccountMeta::new(hdr, false), AccountMeta::new(c, true)];
        for &n in &path { metas.push(AccountMeta::new(self.pda_node(&c, t, n).0, false)); }
        for &s in &sib_idxs { metas.push(AccountMeta::new(self.pda_node(&c, t, s).0, false)); }
        self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|(_, cu)| cu)
    }

    fn pda_dlg(&self, c: &Pubkey, t: u32) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"tdlg", c.as_ref(), &t.to_le_bytes()], &self.prog)
    }

    fn bulk_insert_fast(&mut self, payer: &Keypair, t: u32, keys: &[u32]) -> Result<(), String> {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let first = k32(keys[0]);
        let path = self.path(&c, t, &first);
        let mut d = vec![9u8, path.len() as u8, keys.len() as u8];
        for &kn in keys { d.extend_from_slice(&k32(kn)); d.extend_from_slice(&[(kn & 0xFF) as u8; VS]); }
        let mut metas = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c, true)];
        for (i, &n) in path.iter().enumerate() {
            let pk = self.pda_node(&c, t, n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|_| ())
    }

    fn add_delegate(&mut self, payer: &Keypair, t: u32, delegate: Pubkey) -> Result<(), String> {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let (dlg, bump) = self.pda_dlg(&c, t);
        let mut d = vec![12u8];
        d.extend_from_slice(delegate.as_ref());
        d.push(bump);
        d.extend_from_slice(&self.rent(512).to_le_bytes());
        let metas = vec![
            AccountMeta::new_readonly(hdr, false), AccountMeta::new(c, true),
            AccountMeta::new(dlg, false), AccountMeta::new_readonly(Pubkey::default(), false),
        ];
        self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|_| ())
    }

    fn remove_delegate(&mut self, payer: &Keypair, t: u32, delegate: Pubkey) -> Result<(), String> {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let (dlg, _) = self.pda_dlg(&c, t);
        let mut d = vec![13u8];
        d.extend_from_slice(delegate.as_ref());
        let metas = vec![
            AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c, true),
            AccountMeta::new(dlg, false),
        ];
        self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|_| ())
    }

    // InsertFast signed by `signer`, operating on creator `c`'s tree, with an
    // optional delegate account appended so the program can authorize a delegate.
    fn insert_fast_as(&mut self, c: &Pubkey, signer: &Keypair, t: u32, key_n: u32, dlg: Option<Pubkey>) -> Result<(), String> {
        let (hdr, _) = self.pda_hdr(c, t);
        let key = k32(key_n);
        let path = self.path(c, t, &key);
        let mut d = vec![16u8];
        d.extend_from_slice(&key);
        d.extend_from_slice(&[(key_n & 0xFF) as u8; VS]);
        d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(signer.pubkey(), true)];
        for (i, &n) in path.iter().enumerate() {
            let pk = self.pda_node(c, t, n).0;
            metas.push(if i == path.len() - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        if let Some(da) = dlg { metas.push(AccountMeta::new_readonly(da, false)); }
        self.run(signer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|_| ())
    }

    fn update_fast(&mut self, signer: &Keypair, c: &Pubkey, t: u32, key_n: u32, val: u8) -> Result<(), String> {
        let (hdr, _) = self.pda_hdr(c, t);
        let key = k32(key_n);
        let path = self.path(c, t, &key);
        let mut d = vec![17u8];
        d.extend_from_slice(&key);
        d.extend_from_slice(&[val; VS]);
        d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(signer.pubkey(), true)];
        for (i, &n) in path.iter().enumerate() {
            let leaf = i == path.len() - 1;
            let pk = self.pda_node(c, t, n).0;
            metas.push(if leaf { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        self.run(signer, Instruction::new_with_bytes(self.prog, &d, metas)).map(|_| ())
    }

    fn find(&mut self, payer: &Keypair, t: u32, key_n: u32) -> (bool, u8, u64) {
        let c = payer.pubkey();
        let (hdr, _) = self.pda_hdr(&c, t);
        let key = k32(key_n);
        let path = self.path(&c, t, &key);
        let mut d = vec![3u8]; d.extend_from_slice(&key); d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false)];
        for &n in &path { metas.push(AccountMeta::new_readonly(self.pda_node(&c, t, n).0, false)); }
        let (r, cu) = self.run(payer, Instruction::new_with_bytes(self.prog, &d, metas)).expect("find");
        (r[0] == 1, if r.len() > 1 { r[1] } else { 0 }, cu)
    }
}

fn main() {
    let mut svm = LiteSVM::new();
    let prog = Pubkey::new_unique();
    let bytes = std::fs::read("../sbf/out/torna.so").unwrap();
    svm.add_program(prog, &bytes).unwrap();
    let mut env = Env { svm, prog, slot: 0 };

    let p = Keypair::new();
    env.svm.airdrop(&p.pubkey(), 1_000_000_000_000).unwrap();
    let q = Keypair::new();
    env.svm.airdrop(&q.pubkey(), 1_000_000_000_000).unwrap();

    let mut pass = 0; let mut fail = 0;
    macro_rules! check { ($c:expr, $m:expr) => { if $c { pass+=1; } else { println!("FAIL: {}", $m); fail+=1; } } }

    // ---- functional: build tree A, exercise fast paths ----
    let ta = 7u32;
    env.init(&p, ta);
    let cu_split = env.insert(&p, ta, 10).unwrap();          // first insert (empty->leaf)
    env.insert(&p, ta, 20).unwrap();
    env.insert(&p, ta, 30).unwrap();                          // leaf now {10,20,30}, slack for 1
    let cu_fast = env.insert_fast(&p, ta, 25).unwrap();       // hot path, no split
    let (f1, v1, cu_find) = env.find(&p, ta, 25);
    check!(f1 && v1 == 25, "InsertFast then Find(25)");
    // delete_fast 25
    let r = env.delete_fast(&p, ta, 25).unwrap();
    check!(r[0] == 1 && r[1] == 25, "DeleteFast(25) returns value");
    let (f2, _, _) = env.find(&p, ta, 25);
    check!(!f2, "Find(25) absent after DeleteFast");

    // InsertFast overflow refusal: fill leaf to F then one more must fail NEED_SPLIT
    env.insert_fast(&p, ta, 25).unwrap();   // back to {10,20,25,30} = full (F=4)
    let of = env.insert_fast(&p, ta, 5);
    check!(of.is_err(), "InsertFast refuses overflow (NEED_SPLIT_SLOT)");

    // ---- security T1.1: cross-tree splice ----
    let tb = 8u32;
    env.init(&p, tb);
    env.insert(&p, tb, 99).unwrap();        // tree B has a leaf at idx 1 (B namespace)
    // attack: Insert on A's header but pass B's leaf node as the path
    {
        let c = p.pubkey();
        let (hdr_a, _) = env.pda_hdr(&c, ta);
        let (alc_a, _) = env.pda_alloc(&c, ta);
        let (_r, _h, hw) = env.header(&c, ta);
        let b_leaf = env.pda_node(&c, tb, 1).0;          // B's node, wrong tree
        let key = k32(1);
        let rent_node = env.rent(env.node_size());
        let mut d = vec![2u8]; d.extend_from_slice(&key); d.extend_from_slice(&[1u8; VS]);
        d.push(1u8); d.push(2u8); d.extend_from_slice(&rent_node.to_le_bytes());
        let mut spares = vec![];
        for i in 0..2 { let (pk, b) = env.pda_node(&c, ta, hw as u64 + 1 + i); d.push(b); spares.push(pk); }
        let mut metas = vec![
            AccountMeta::new(hdr_a, false), AccountMeta::new(c, true),
            AccountMeta::new(alc_a, false), AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new(b_leaf, false),                 // <-- spliced foreign node
        ];
        for &s in &spares { metas.push(AccountMeta::new(s, false)); }
        let res = env.run(&p, Instruction::new_with_bytes(prog, &d, metas));
        check!(res.is_err(), "T1.1 cross-tree splice rejected");
    }

    // ---- security T2.1: unauthorized write ----
    // operate on tree A (creator = p's namespace) but sign with q, who is not the
    // authority. The accounts are p's; only the signer differs.
    {
        let c = p.pubkey();
        let (hdr_a, _) = env.pda_hdr(&c, ta);
        let key = k32(40);
        let path = env.path(&c, ta, &key);
        let mut d = vec![16u8];
        d.extend_from_slice(&key);
        d.extend_from_slice(&[40u8; VS]);
        d.push(path.len() as u8);
        let mut metas = vec![
            AccountMeta::new_readonly(hdr_a, false),
            AccountMeta::new_readonly(q.pubkey(), true),  // q signs but is not authority
        ];
        for (i, &n) in path.iter().enumerate() {
            let leaf = i == path.len() - 1;
            let pk = env.pda_node(&c, ta, n).0;
            metas.push(if leaf { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        let res = env.run(&q, Instruction::new_with_bytes(prog, &d, metas));
        check!(res.is_err(), "T2.1 unauthorized InsertFast rejected");
    }

    // ---- security T1.3: wrong (but valid) node in path ----
    {
        // Find on A but pass A's node idx that is not the root as the root slot.
        let c = p.pubkey();
        let (hdr_a, _) = env.pda_hdr(&c, ta);
        let (root, height, _) = env.header(&c, ta);
        // pick some non-root node idx (root+1 likely exists after splits)
        let wrong = if root > 1 { 1 } else { root + 1 };
        let key = k32(10);
        let mut d = vec![3u8]; d.extend_from_slice(&key); d.push(height as u8);
        let mut metas = vec![AccountMeta::new_readonly(hdr_a, false)];
        // root slot gets the WRONG node; remaining path filler (root) just to fill count
        metas.push(AccountMeta::new_readonly(env.pda_node(&c, ta, wrong).0, false));
        for _ in 1..height { metas.push(AccountMeta::new_readonly(env.pda_node(&c, ta, root).0, false)); }
        let res = env.run(&p, Instruction::new_with_bytes(prog, &d, metas));
        check!(res.is_err(), "T1.3 wrong node in path rejected");
    }

    // ---- security T5.1: truncated ix data ----
    {
        let c = p.pubkey();
        let (hdr_a, _) = env.pda_hdr(&c, ta);
        let res = env.run(&p, Instruction::new_with_bytes(prog, &[3u8, 0, 0], // disc=Find, then garbage/too short
            vec![AccountMeta::new_readonly(hdr_a, false)]));
        check!(res.is_err(), "T5.1 truncated ix data rejected");
    }

    // ---- security T1.6: RangeScan scratch must be program-owned ----
    {
        let c = p.pubkey();
        let key = k32(10);
        let path = env.path(&c, ta, &key);
        let foreign_scratch = Pubkey::new_unique(); // never created -> system-owned
        let mut d = vec![4u8];
        d.extend_from_slice(&key); d.extend_from_slice(&k32(30));
        d.push(path.len() as u8); d.extend_from_slice(&8u16.to_le_bytes());
        let mut metas = vec![
            AccountMeta::new_readonly(env.pda_hdr(&c, ta).0, false),
            AccountMeta::new(foreign_scratch, false),    // <-- not program-owned
        ];
        for &n in &path { metas.push(AccountMeta::new_readonly(env.pda_node(&c, ta, n).0, false)); }
        let res = env.run(&p, Instruction::new_with_bytes(prog, &d, metas));
        check!(res.is_err(), "T1.6 non-program-owned scratch rejected");
    }

    // ---- TransferAuthority + T2.5 (transfer-to-zero forbidden) ----
    {
        let tc = 9u32;
        env.init(&p, tc);
        let (hdr_c, _) = env.pda_hdr(&p.pubkey(), tc);
        let authority_of = |env: &Env| -> Pubkey {
            let d = env.acc(&hdr_c).unwrap();
            Pubkey::try_from(&d[90..122]).unwrap()
        };
        check!(authority_of(&env) == p.pubkey(), "initial authority is creator");
        // transfer p -> q
        let mut d = vec![11u8]; d.extend_from_slice(q.pubkey().as_ref());
        let metas = vec![AccountMeta::new(hdr_c, false), AccountMeta::new_readonly(p.pubkey(), true)];
        env.run(&p, Instruction::new_with_bytes(prog, &d, metas)).expect("transfer");
        check!(authority_of(&env) == q.pubkey(), "authority transferred p->q");
        // T2.5: transfer to all-zero must be rejected (signed by q, the new authority)
        let mut z = vec![11u8]; z.extend_from_slice(&[0u8; 32]);
        let zmetas = vec![AccountMeta::new(hdr_c, false), AccountMeta::new_readonly(q.pubkey(), true)];
        let res = env.run(&q, Instruction::new_with_bytes(prog, &z, zmetas));
        check!(res.is_err(), "T2.5 transfer-to-zero rejected");
        // p can no longer transfer (not authority anymore)
        let mut d2 = vec![11u8]; d2.extend_from_slice(p.pubkey().as_ref());
        let m2 = vec![AccountMeta::new(hdr_c, false), AccountMeta::new_readonly(p.pubkey(), true)];
        let res2 = env.run(&p, Instruction::new_with_bytes(prog, &d2, m2));
        check!(res2.is_err(), "old authority cannot transfer after rotation");
    }

    // ---- full Delete differential: insert 1..=30, delete a sequence, verify ----
    {
        let td = 11u32;
        env.init(&p, td);
        for n in 1..=30u32 { env.insert(&p, td, n).unwrap(); }
        let (_r, h_full, _) = env.header(&p.pubkey(), td);
        // delete 1..=28 ascending (stresses merges, leftmost handling, root collapse)
        let mut present: std::collections::HashSet<u32> = (1..=30).collect();
        let mut ok = true;
        for n in 1..=28u32 {
            env.delete(&p, td, n).unwrap_or_else(|e| panic!("delete {n}: {e}"));
            present.remove(&n);
            // deleted key absent; a survivor still found
            if env.find(&p, td, n).0 { ok = false; }
            if !env.find(&p, td, 30).0 { ok = false; }
        }
        check!(ok, "Delete differential: deleted absent, survivors present");
        // full membership check vs oracle
        let mut member_ok = true;
        for n in 1..=30u32 { if env.find(&p, td, n).0 != present.contains(&n) { member_ok = false; } }
        check!(member_ok, "Delete: full membership matches oracle");
        let (_r, h_after, _) = env.header(&p.pubkey(), td);
        check!(h_after < h_full, "Delete: tree height shrank (root collapse)");
        // delete a missing key fails
        check!(env.delete(&p, td, 1).is_err(), "Delete missing key rejected");
        // empty the tree
        env.delete(&p, td, 29).unwrap();
        env.delete(&p, td, 30).unwrap();
        let (_r, h_empty, _) = env.header(&p.pubkey(), td);
        check!(h_empty == 0, "Delete: tree empties to height 0");
        println!("Delete differential: 1..30 inserted, 30 deleted, height {h_full}->{h_empty}");
    }

    // ---- Delete differential, RANDOM order (exercises borrow + both merge sides) ----
    {
        let tr = 12u32;
        env.init(&p, tr);
        let k = 40u32;
        for n in 1..=k { env.insert(&p, tr, n).unwrap(); }
        let mut present: std::collections::HashSet<u32> = (1..=k).collect();
        // deterministic shuffle of 1..=k via xorshift
        let mut order: Vec<u32> = (1..=k).collect();
        let mut s = 0x9E3779B9u32;
        for i in (1..order.len()).rev() {
            s ^= s << 13; s ^= s >> 17; s ^= s << 5;
            let j = (s as usize) % (i + 1);
            order.swap(i, j);
        }
        let mut ok = true;
        // delete ~70% in random order, checking membership against oracle each step
        for &n in order.iter().take((k as usize * 7) / 10) {
            env.delete(&p, tr, n).unwrap_or_else(|e| panic!("rand delete {n}: {e}"));
            present.remove(&n);
            if env.find(&p, tr, n).0 { ok = false; }
        }
        for n in 1..=k { if env.find(&p, tr, n).0 != present.contains(&n) { ok = false; } }
        check!(ok, "Delete differential (random order) matches oracle");
        // RangeScan the survivors and verify ascending + complete
        let cap = 64usize;
        let scratch = Pubkey::new_unique();
        env.svm.set_account(scratch, solana_sdk::account::Account {
            lamports: 1_000_000_000, data: vec![0u8; 6 + cap * (KEY + VS)],
            owner: prog, executable: false, rent_epoch: 0,
        }).unwrap();
        let skey = k32(1);
        let path = env.path(&p.pubkey(), tr, &skey);
        let mut extra = vec![];
        let mut cur = *path.last().unwrap();
        loop {
            let d = env.acc(&env.pda_node(&p.pubkey(), tr, cur).0).unwrap();
            let nx = u64::from_le_bytes(d[20..28].try_into().unwrap());
            if nx == 0 { break; } extra.push(nx); cur = nx; if extra.len() > 64 { break; }
        }
        let mut d = vec![4u8]; d.extend_from_slice(&skey); d.extend_from_slice(&k32(k));
        d.push(path.len() as u8); d.extend_from_slice(&(cap as u16).to_le_bytes());
        let mut metas = vec![AccountMeta::new_readonly(env.pda_hdr(&p.pubkey(), tr).0, false), AccountMeta::new(scratch, false)];
        for &n in &path { metas.push(AccountMeta::new_readonly(env.pda_node(&p.pubkey(), tr, n).0, false)); }
        for &n in &extra { metas.push(AccountMeta::new_readonly(env.pda_node(&p.pubkey(), tr, n).0, false)); }
        env.run(&p, Instruction::new_with_bytes(prog, &d, metas)).expect("range after deletes");
        let sd = env.acc(&scratch).unwrap();
        let cnt = u16::from_le_bytes(sd[4..6].try_into().unwrap()) as usize;
        let mut survivors: Vec<u32> = present.iter().copied().collect();
        survivors.sort();
        let mut range_ok = cnt == survivors.len();
        for (i, &want) in survivors.iter().enumerate() {
            let off = 6 + i * (KEY + VS);
            if u32::from_be_bytes(sd[off + 28..off + 32].try_into().unwrap()) != want { range_ok = false; }
        }
        check!(range_ok, "RangeScan after random deletes returns survivors in order");
        println!("Delete random+RangeScan: {} survivors, chain intact", cnt);
    }

    // ---- BulkInsertFast (market-maker primitive) ----
    {
        let tbk = 13u32;
        env.init(&p, tbk);
        env.insert(&p, tbk, 100).unwrap();
        env.insert(&p, tbk, 200).unwrap();           // leaf {100,200}, slack 2 at F=4
        env.bulk_insert_fast(&p, tbk, &[130, 160]).expect("bulk insert");  // -> {100,130,160,200}
        let mut all = true;
        for k in [100, 130, 160, 200] { if !env.find(&p, tbk, k).0 { all = false; } }
        check!(all, "BulkInsertFast: all 4 keys present");
        // overflow refusal: leaf is full (4=F), one more must fail
        check!(env.bulk_insert_fast(&p, tbk, &[150]).is_err(), "BulkInsertFast refuses overflow");
        // non-ascending batch rejected
        let te = 15u32; env.init(&p, te); env.insert(&p, te, 1).unwrap();
        check!(env.bulk_insert_fast(&p, te, &[9, 5]).is_err(), "BulkInsertFast rejects non-ascending");
    }

    // ---- Delegates: additive multi-signer authorization ----
    {
        let td2 = 14u32;
        env.init(&p, td2);
        env.insert(&p, td2, 50).unwrap();             // height 1, leaf {50}, slack
        // q is not authorized yet
        check!(env.insert_fast_as(&p.pubkey(), &q, td2, 60, None).is_err(), "non-delegate q rejected");
        // add q as delegate
        env.add_delegate(&p, td2, q.pubkey()).expect("add delegate");
        let (dlg, _) = env.pda_dlg(&p.pubkey(), td2);
        // now q can write (delegate account supplied)
        check!(env.insert_fast_as(&p.pubkey(), &q, td2, 60, Some(dlg)).is_ok(), "delegate q can InsertFast");
        check!(env.find(&p, td2, 60).0, "delegate's write is present");
        // remove q; it can no longer write
        env.remove_delegate(&p, td2, q.pubkey()).expect("remove delegate");
        check!(env.insert_fast_as(&p.pubkey(), &q, td2, 70, Some(dlg)).is_err(), "removed delegate rejected");
        // a non-primary (q) cannot add delegates on p's tree
        {
            let c = p.pubkey();
            let (hdr, _) = env.pda_hdr(&c, td2);
            let (dlg2, bump) = env.pda_dlg(&c, td2);
            let mut d = vec![12u8];
            d.extend_from_slice(q.pubkey().as_ref());
            d.push(bump);
            d.extend_from_slice(&env.rent(512).to_le_bytes());
            let metas = vec![
                AccountMeta::new_readonly(hdr, false), AccountMeta::new(q.pubkey(), true),
                AccountMeta::new(dlg2, false), AccountMeta::new_readonly(Pubkey::default(), false),
            ];
            check!(env.run(&q, Instruction::new_with_bytes(prog, &d, metas)).is_err(),
                   "non-primary cannot add delegate");
        }
    }

    // ---- MultiLeafInsertFast: atomic insert across two adjacent leaves ----
    {
        let tm = 16u32;
        env.init(&p, tm);
        for n in [10u32, 20, 30, 40, 50] { env.insert(&p, tm, n).unwrap(); } // -> left{10,20} right{30,40,50}
        let c = p.pubkey();
        let (hdr, _) = env.pda_hdr(&c, tm);
        let path0 = env.path(&c, tm, &k32(15)); // [root, left]
        let path1 = env.path(&c, tm, &k32(35)); // [root, right]
        let path_len = path0.len();
        check!(path_len == 2 && path0[0] == path1[0] && path0[1] != path1[1], "two adjacent leaves");
        let mut d = vec![14u8, path_len as u8, 2u8, 1u8, 1u8];
        d.extend_from_slice(&k32(15)); d.extend_from_slice(&[15u8; VS]);
        d.extend_from_slice(&k32(35)); d.extend_from_slice(&[35u8; VS]);
        let mut metas = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c, true)];
        for (i, &n) in path0.iter().enumerate() {
            let pk = env.pda_node(&c, tm, n).0;
            metas.push(if i == path_len - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        for (i, &n) in path1.iter().enumerate() {
            let pk = env.pda_node(&c, tm, n).0;
            metas.push(if i == path_len - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) });
        }
        env.run(&p, Instruction::new_with_bytes(prog, &d, metas)).expect("multi-leaf insert");
        check!(env.find(&p, tm, 15).0 && env.find(&p, tm, 35).0, "MultiLeaf: both entries present");
        // non-adjacent / cross-order: swapping the two leaf blocks must fail (cross-leaf ordering)
        let mut d2 = vec![14u8, path_len as u8, 2u8, 1u8, 1u8];
        d2.extend_from_slice(&k32(36)); d2.extend_from_slice(&[36u8; VS]); // higher key in first block
        d2.extend_from_slice(&k32(16)); d2.extend_from_slice(&[16u8; VS]); // lower key in second block
        let mut m2 = vec![AccountMeta::new_readonly(hdr, false), AccountMeta::new_readonly(c, true)];
        for (i, &n) in path1.iter().enumerate() { let pk = env.pda_node(&c, tm, n).0;
            m2.push(if i == path_len - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
        for (i, &n) in path0.iter().enumerate() { let pk = env.pda_node(&c, tm, n).0;
            m2.push(if i == path_len - 1 { AccountMeta::new(pk, false) } else { AccountMeta::new_readonly(pk, false) }); }
        check!(env.run(&p, Instruction::new_with_bytes(prog, &d2, m2)).is_err(), "MultiLeaf rejects out-of-order leaves");
    }

    // ---- security T1.5: spare substitution in Insert ----
    {
        let ts = 17u32;
        env.init(&p, ts);
        for n in [1u32, 2, 3, 4] { env.insert(&p, ts, n).unwrap(); } // leaf full at F=4
        let c = p.pubkey();
        let (hdr, _) = env.pda_hdr(&c, ts);
        let (alc, _) = env.pda_alloc(&c, ts);
        let (_r, _h, hw) = env.header(&c, ts);
        let path = env.path(&c, ts, &k32(5));
        let (_good_spare, bump) = env.pda_node(&c, ts, hw as u64 + 1);
        let wrong_spare = Pubkey::new_unique(); // not the canonical PDA
        let rent_node = env.rent(env.node_size());
        let mut d = vec![2u8]; d.extend_from_slice(&k32(5)); d.extend_from_slice(&[5u8; VS]);
        d.push(path.len() as u8); d.push(1u8); d.extend_from_slice(&rent_node.to_le_bytes()); d.push(bump);
        let mut metas = vec![
            AccountMeta::new(hdr, false), AccountMeta::new(c, true),
            AccountMeta::new(alc, false), AccountMeta::new_readonly(Pubkey::default(), false),
        ];
        for &n in &path { metas.push(AccountMeta::new(env.pda_node(&c, ts, n).0, false)); }
        metas.push(AccountMeta::new(wrong_spare, false)); // <-- non-canonical spare
        check!(env.run(&p, Instruction::new_with_bytes(prog, &d, metas)).is_err(),
               "T1.5 non-canonical spare rejected");
    }

    // ---- security: cross-TENANT splice (two creators, same tree_id) [Fix 1] ----
    // p and q both own a tree with tree_id=7. An attacker authorized on their OWN
    // tree must NOT be able to splice a victim's node that shares (tree_id,node_idx).
    {
        // q creates its own tree_id=7 (creator=q) and inserts -> q's node_idx 1.
        env.init(&q, ta);
        env.insert(&q, ta, 500).unwrap();
        let q_node1 = env.pda_node(&q.pubkey(), ta, 1).0; // victim node, tree_uid(q,7)
        // attacker p operates on ITS tree (creator p, tree_id 7) but passes q's node.
        let (hdr_p, _) = env.pda_hdr(&p.pubkey(), ta);
        let key = k32(1);
        let mut d = vec![16u8]; d.extend_from_slice(&key); d.extend_from_slice(&[1u8; VS]); d.push(1u8);
        let metas = vec![
            AccountMeta::new_readonly(hdr_p, false),
            AccountMeta::new_readonly(p.pubkey(), true),
            AccountMeta::new(q_node1, false),   // <-- foreign-creator node, same (tree_id,idx)
        ];
        let res = env.run(&p, Instruction::new_with_bytes(prog, &d, metas));
        check!(res.is_err(), "cross-tenant splice (same tree_id, diff creator) rejected");
    }

    // ---- UpdateFast (disc 17): value-only in-place update ----
    {
        let te = 30u32;
        env.init(&p, te);
        let c = p.pubkey();
        for kn in [10u32, 20, 30] { env.insert(&p, te, kn).unwrap(); }
        let (_f0, v0, _) = env.find(&p, te, 20);
        check!(v0 == (20u8 & 0xFF), "UpdateFast: pre-update value as inserted");
        check!(env.update_fast(&p, &c, te, 20, 0xAB).is_ok(), "UpdateFast updates an existing key");
        let (f1, v1, _) = env.find(&p, te, 20);
        check!(f1 && v1 == 0xAB, "UpdateFast: value actually changed");
        // key set + neighbours intact (no reorder)
        check!(env.find(&p, te, 10).0 && env.find(&p, te, 30).0, "UpdateFast: neighbours intact");
        // missing key -> error
        check!(env.update_fast(&p, &c, te, 999, 0x01).is_err(), "UpdateFast on a missing key rejected");
        // authorization: a non-authority signer cannot update a closed tree
        check!(env.update_fast(&q, &c, te, 20, 0xCC).is_err(), "UpdateFast by a non-authority rejected");
        let (_f2, v2, _) = env.find(&p, te, 20);
        check!(v2 == 0xAB, "UpdateFast: rejected update left the value unchanged");
    }

    // ---- CompactLeaf: reclaim an emptied leftmost leaf (keeper) ----
    {
        let tcp = 40u32;
        env.init(&p, tcp);
        for n in 1u32..=12 { env.insert(&p, tcp, n).unwrap(); }
        let c = p.pubkey();
        let hd = env.acc(&env.pda_hdr(&c, tcp).0).unwrap();
        let leftmost = u64::from_le_bytes(hd[66..74].try_into().unwrap());
        let ld = env.acc(&env.pda_node(&c, tcp, leftmost).0).unwrap();
        let kc = u16::from_le_bytes(ld[2..4].try_into().unwrap()) as usize;
        let leaf_keys: Vec<u32> = (0..kc).map(|i| u32::from_be_bytes(ld[HDR + i * KEY + 28..HDR + i * KEY + 32].try_into().unwrap())).collect();
        // empty the leftmost leaf via DeleteFast (no rebalance -> leaf left empty)
        for &kn in &leaf_keys { env.delete_fast(&p, tcp, kn).unwrap(); }
        let leaf_acct = env.pda_node(&c, tcp, leftmost).0;
        let lam_before = env.svm.get_account(&leaf_acct).map(|a| a.lamports).unwrap_or(0);
        // CompactLeaf (path = the all-kids[0] leftmost chain, via the old min key)
        let path = env.path(&c, tcp, &k32(leaf_keys[0]));
        let mut d = vec![6u8]; d.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new(env.pda_hdr(&c, tcp).0, false), AccountMeta::new(c, true)];
        for &n in &path { metas.push(AccountMeta::new(env.pda_node(&c, tcp, n).0, false)); }
        check!(env.run(&p, Instruction::new_with_bytes(prog, &d, metas)).is_ok(), "CompactLeaf removes the empty leftmost leaf");
        let hd2 = env.acc(&env.pda_hdr(&c, tcp).0).unwrap();
        let new_leftmost = u64::from_le_bytes(hd2[66..74].try_into().unwrap());
        check!(new_leftmost != leftmost, "CompactLeaf advanced leftmost");
        check!(lam_before > 0 && env.svm.get_account(&leaf_acct).map(|a| a.lamports).unwrap_or(0) == 0, "CompactLeaf reclaimed the leaf's rent");
        check!(env.find(&p, tcp, 12).0, "CompactLeaf: other keys intact");
        // a non-empty leftmost cannot be compacted
        let nld = env.acc(&env.pda_node(&c, tcp, new_leftmost).0).unwrap();
        let min_remaining = u32::from_be_bytes(nld[HDR + 28..HDR + 32].try_into().unwrap());
        let path2 = env.path(&c, tcp, &k32(min_remaining));
        let mut d2 = vec![6u8]; d2.push(path2.len() as u8);
        let mut m2 = vec![AccountMeta::new(env.pda_hdr(&c, tcp).0, false), AccountMeta::new(c, true)];
        for &n in &path2 { m2.push(AccountMeta::new(env.pda_node(&c, tcp, n).0, false)); }
        check!(env.run(&p, Instruction::new_with_bytes(prog, &d2, m2)).is_err(), "CompactLeaf rejects a non-empty leftmost");
    }

    // ---- security: RangeScan scratch must not be a live Torna account [round-3 fix] ----
    // owner==program is not enough -- a victim's header/node is also program-owned.
    {
        let c = p.pubkey();
        let (hdr_a, _) = env.pda_hdr(&c, ta);
        let key = k32(10);
        let path = env.path(&c, ta, &key);
        let node_pdas: Vec<Pubkey> = path.iter().map(|&n| env.pda_node(&c, ta, n).0).collect();
        let node1 = node_pdas[0];
        let build = |scratch: Pubkey| -> Instruction {
            let mut d = vec![4u8];
            d.extend_from_slice(&k32(1)); d.extend_from_slice(&k32(30));
            d.push(node_pdas.len() as u8); d.extend_from_slice(&16u16.to_le_bytes());
            let mut metas = vec![AccountMeta::new_readonly(hdr_a, false), AccountMeta::new(scratch, false)];
            for &pk in &node_pdas { metas.push(AccountMeta::new_readonly(pk, false)); }
            Instruction::new_with_bytes(prog, &d, metas)
        };
        let ix_hdr = build(hdr_a);
        let ix_node = build(node1);
        // scratch = the tree's own header (carries TORNA_MAGIC) -> rejected
        check!(env.run(&p, ix_hdr).is_err(), "RangeScan rejects a header as scratch");
        // scratch = a live node (initialized flag) -> rejected
        check!(env.run(&p, ix_node).is_err(), "RangeScan rejects a node as scratch");
    }

    // ---- security: delegates must NOT survive TransferAuthority [round-4 fix] ----
    {
        let td3 = 21u32;
        env.init(&p, td3);
        env.insert(&p, td3, 100).unwrap();
        env.add_delegate(&p, td3, q.pubkey()).unwrap();
        let (dlg, _) = env.pda_dlg(&p.pubkey(), td3);
        // q (delegate) can write while p is the authority
        check!(env.insert_fast_as(&p.pubkey(), &q, td3, 50, Some(dlg)).is_ok(), "delegate writes under original authority");
        // transfer authority p -> r
        let r = Keypair::new();
        env.svm.airdrop(&r.pubkey(), 1_000_000_000).unwrap();
        let (hdr3, _) = env.pda_hdr(&p.pubkey(), td3);
        let mut d = vec![11u8]; d.extend_from_slice(r.pubkey().as_ref());
        let metas = vec![AccountMeta::new(hdr3, false), AccountMeta::new_readonly(p.pubkey(), true)];
        env.run(&p, Instruction::new_with_bytes(prog, &d, metas)).expect("transfer authority");
        // q's delegate access is now stale (authorizing != new authority) -> rejected
        check!(env.insert_fast_as(&p.pubkey(), &q, td3, 60, Some(dlg)).is_err(), "delegate stale after TransferAuthority");
    }

    // ---- security: cross-tenant delegate injection [systematic-sweep fix] ----
    // p owns a delegate account; q (same tree_id, own tree) must NOT be able to
    // inject itself into p's delegate list (which would authorize q on p's tree).
    {
        let tdel = 20u32;
        env.init(&p, tdel);
        env.add_delegate(&p, tdel, Pubkey::new_unique()).unwrap(); // creates p's delegate acct
        env.init(&q, tdel);                                         // q's own tree_id=20
        let (p_dlg, p_bump) = env.pda_dlg(&p.pubkey(), tdel);       // victim's delegate account
        let (q_hdr, _) = env.pda_hdr(&q.pubkey(), tdel);
        let mut d = vec![12u8];
        d.extend_from_slice(q.pubkey().as_ref());                   // inject q as a delegate
        d.push(p_bump);
        d.extend_from_slice(&env.rent(512).to_le_bytes());
        let metas = vec![
            AccountMeta::new_readonly(q_hdr, false), AccountMeta::new(q.pubkey(), true),
            AccountMeta::new(p_dlg, false),                          // <-- victim's delegate acct
            AccountMeta::new_readonly(Pubkey::default(), false),
        ];
        check!(env.run(&q, Instruction::new_with_bytes(prog, &d, metas)).is_err(),
               "cross-tenant delegate injection rejected");
    }

    // ---- security: cross-leaf bulk insert (key past the leaf separator) [Fix 2] ----
    {
        let tx = 18u32;
        env.init(&p, tx);
        for n in [10u32, 20, 30, 40, 50] { env.insert(&p, tx, n).unwrap(); } // L0={10,20} L1={30,40,50}
        // valid batch: both keys route to L0 (control)
        check!(env.bulk_insert_fast(&p, tx, &[15, 25]).is_ok(), "in-range bulk accepted");
        // malicious batch: 35 routes to L1 (>= separator 30) but first key 12 picks L0
        check!(env.bulk_insert_fast(&p, tx, &[12, 35]).is_err(), "cross-leaf bulk (key past separator) rejected");
    }

    println!("\nCU: Insert(first/split-path)={cu_split}  InsertFast={cu_fast}  Find={cu_find}");
    check!(cu_fast < 30_000, "InsertFast CU under 30k budget");
    check!(cu_find < 30_000, "Find CU under 30k budget");
    check!(cu_split < 120_000, "Insert(split path) CU under 120k budget");

    println!("\nintegration+security+CU: pass={pass} fail={fail} -> {}",
             if fail == 0 { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
