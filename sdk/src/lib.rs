//! Torna client SDK -- the PathPlanner.
//!
//! Integrators call insert/update/delete/find with a 32-byte key; the planner reads
//! the tree off-chain (via an `AccountReader`) and produces a ready `Instruction`
//! with the exact account set. node_idx, bumps, paths, and spares never leak out.
//!
//! Layout constants mirror the FROZEN ABI (torna_docs/abi.md). If the engine layout
//! changes, change it here too -- the cpitest/inttest in torna/integration will catch
//! a mismatch because the SDK-built instructions run against the real torna.so.

use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

// ---- instruction discriminators ----
pub const IX_INIT_TREE: u8 = 0;
pub const IX_INSERT: u8 = 2;
pub const IX_FIND: u8 = 3;
pub const IX_INSERT_FAST: u8 = 16;
pub const IX_UPDATE_FAST: u8 = 17;
pub const IX_DELETE_FAST: u8 = 18;

// ---- frozen layout (abi.md) ----
pub const KEY_SIZE: usize = 32;
pub const NODE_HDR: usize = 44;
pub const TREE_HEADER_SIZE: usize = 146;
pub const ALLOC_SIZE: usize = 32;

// header field offsets
const H_VALUE_SIZE: usize = 46;
const H_FANOUT: usize = 48;
const H_NODE_SIZE: usize = 50;
const H_ROOT: usize = 54;
const H_HEIGHT: usize = 62;
const H_LEFTMOST: usize = 66;
const H_RIGHTMOST: usize = 74;
const H_AUTHORITY: usize = 90;
// node field offsets
const N_KEY_COUNT: usize = 2;
const N_NODE_IDX: usize = 12;
const N_NEXT_LEAF: usize = 20;
// allocator
const A_HIGH_WATER: usize = 8;

fn rd_u16(d: &[u8], o: usize) -> u16 { u16::from_le_bytes(d[o..o + 2].try_into().unwrap()) }
fn rd_u32(d: &[u8], o: usize) -> u32 { u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }
fn rd_u64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }

/// Anything that can fetch raw account data (LiteSVM, RPC, a cache).
pub trait AccountReader {
    fn account_data(&self, key: &Pubkey) -> Option<Vec<u8>>;
}

/// Parsed, cache-relevant header fields.
#[derive(Clone, Copy, Debug)]
pub struct Header {
    pub value_size: u16,
    pub fanout: u16,
    pub node_size: u32,
    pub root: u64,
    pub height: u32,
    pub leftmost: u64,
    pub rightmost: u64,
    pub authority: Pubkey,
}

impl Header {
    fn parse(d: &[u8]) -> Header {
        Header {
            value_size: rd_u16(d, H_VALUE_SIZE),
            fanout: rd_u16(d, H_FANOUT),
            node_size: rd_u32(d, H_NODE_SIZE),
            root: rd_u64(d, H_ROOT),
            height: rd_u32(d, H_HEIGHT),
            leftmost: rd_u64(d, H_LEFTMOST),
            rightmost: rd_u64(d, H_RIGHTMOST),
            authority: Pubkey::new_from_array(d[H_AUTHORITY..H_AUTHORITY + 32].try_into().unwrap()),
        }
    }
}

/// A handle to one tree: (program, creator, tree_id). All PDA/seed logic lives here.
#[derive(Clone, Copy, Debug)]
pub struct Tree {
    pub program: Pubkey,
    pub creator: Pubkey,
    pub tree_id: u32,
}

impl Tree {
    pub fn new(program: Pubkey, creator: Pubkey, tree_id: u32) -> Self {
        Tree { program, creator, tree_id }
    }

    pub fn header_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"thdr", self.creator.as_ref(), &self.tree_id.to_le_bytes()], &self.program)
    }
    pub fn alloc_pda(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"talloc", self.creator.as_ref(), &self.tree_id.to_le_bytes()], &self.program)
    }
    pub fn node_pda(&self, idx: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"tnode", self.creator.as_ref(), &self.tree_id.to_le_bytes(), &idx.to_le_bytes()], &self.program)
    }

    pub fn header(&self, r: &dyn AccountReader) -> Option<Header> {
        r.account_data(&self.header_pda().0).map(|d| Header::parse(&d))
    }
    fn high_water(&self, r: &dyn AccountReader) -> Option<u64> {
        r.account_data(&self.alloc_pda().0).map(|d| rd_u64(&d, A_HIGH_WATER))
    }

    /// Descent path root..leaf (node_idx list) for `key`. Empty if the tree is empty.
    /// Mirrors the engine's descent: lower_bound, then "key == separator -> go right".
    pub fn path(&self, r: &dyn AccountReader, key: &[u8; 32]) -> Option<Vec<u64>> {
        let h = self.header(r)?;
        if h.height == 0 { return Some(vec![]); }
        let f = h.fanout as usize;
        let kids_off = NODE_HDR + (f + 1) * KEY_SIZE;
        let mut cur = h.root;
        let mut path = vec![cur];
        for _ in 0..h.height - 1 {
            let d = r.account_data(&self.node_pda(cur).0)?;
            let cnt = rd_u16(&d, N_KEY_COUNT) as usize;
            // lower_bound: first i with keys[i] >= key
            let (mut lo, mut hi) = (0usize, cnt);
            while lo < hi {
                let m = (lo + hi) / 2;
                let mk = &d[NODE_HDR + m * KEY_SIZE..NODE_HDR + m * KEY_SIZE + KEY_SIZE];
                if mk < &key[..] { lo = m + 1; } else { hi = m; }
            }
            let eq = lo < cnt && &d[NODE_HDR + lo * KEY_SIZE..NODE_HDR + lo * KEY_SIZE + KEY_SIZE] == &key[..];
            let slot = if eq { lo + 1 } else { lo };
            cur = rd_u64(&d, kids_off + slot * 8);
            path.push(cur);
        }
        Some(path)
    }

    fn path_metas(&self, path: &[u64], leaf_writable: bool) -> Vec<AccountMeta> {
        path.iter().enumerate().map(|(i, &n)| {
            let pk = self.node_pda(n).0;
            if leaf_writable && i == path.len() - 1 { AccountMeta::new(pk, false) }
            else { AccountMeta::new_readonly(pk, false) }
        }).collect()
    }

    // ---- hot path: header read-only, only the leaf writable (parallelizable) ----

    /// InsertFast: place a new key/value into an existing leaf (fails if the leaf is
    /// full -> caller falls back to `insert` for the cold split path).
    pub fn insert_fast_ix(&self, r: &dyn AccountReader, authority: Pubkey, key: &[u8; 32], value: &[u8]) -> Option<Instruction> {
        let path = self.path(r, key)?;
        let mut data = vec![IX_INSERT_FAST];
        data.extend_from_slice(key); data.extend_from_slice(value); data.push(path.len() as u8);
        Some(self.fast_ix(authority, data, &path))
    }
    /// UpdateFast: overwrite the value of an existing key in place.
    pub fn update_fast_ix(&self, r: &dyn AccountReader, authority: Pubkey, key: &[u8; 32], value: &[u8]) -> Option<Instruction> {
        let path = self.path(r, key)?;
        let mut data = vec![IX_UPDATE_FAST];
        data.extend_from_slice(key); data.extend_from_slice(value); data.push(path.len() as u8);
        Some(self.fast_ix(authority, data, &path))
    }
    /// DeleteFast: remove a key without rebalancing (a leaf may drop below MIN).
    pub fn delete_fast_ix(&self, r: &dyn AccountReader, authority: Pubkey, key: &[u8; 32]) -> Option<Instruction> {
        let path = self.path(r, key)?;
        let mut data = vec![IX_DELETE_FAST];
        data.extend_from_slice(key); data.push(path.len() as u8);
        Some(self.fast_ix(authority, data, &path))
    }
    fn fast_ix(&self, authority: Pubkey, data: Vec<u8>, path: &[u64]) -> Instruction {
        let mut metas = vec![
            AccountMeta::new_readonly(self.header_pda().0, false),
            AccountMeta::new_readonly(authority, true),
        ];
        metas.extend(self.path_metas(path, true));
        Instruction::new_with_bytes(self.program, &data, metas)
    }

    /// Find: returns the instruction; the caller reads return_data [found u8, value..].
    pub fn find_ix(&self, r: &dyn AccountReader, key: &[u8; 32]) -> Option<Instruction> {
        let path = self.path(r, key)?;
        let mut data = vec![IX_FIND]; data.extend_from_slice(key); data.push(path.len() as u8);
        let mut metas = vec![AccountMeta::new_readonly(self.header_pda().0, false)];
        metas.extend(self.path_metas(&path, false));
        Some(Instruction::new_with_bytes(self.program, &data, metas))
    }

    // ---- cold path: Insert (descends, may split via CPI-created spares) ----

    /// Insert (cold path): handles the empty-tree first insert and splits. Resolves the
    /// spare node PDAs (height+2 of them) the engine may need. `rent_node` = rent-exempt
    /// lamports for one node account (caller computes from its client).
    pub fn insert_ix(&self, r: &dyn AccountReader, payer: Pubkey, key: &[u8; 32], value: &[u8], rent_node: u64) -> Option<Instruction> {
        let h = self.header(r)?;
        let hw = self.high_water(r)?;
        let path = self.path(r, key)?;
        let spare_n = h.height as usize + 2;
        let mut data = vec![IX_INSERT];
        data.extend_from_slice(key); data.extend_from_slice(value);
        data.push(path.len() as u8); data.push(spare_n as u8);
        data.extend_from_slice(&rent_node.to_le_bytes());
        let mut spares = Vec::with_capacity(spare_n);
        for i in 0..spare_n as u64 {
            let (pk, b) = self.node_pda(hw + 1 + i);
            data.push(b); spares.push(pk);
        }
        let mut metas = vec![
            AccountMeta::new(self.header_pda().0, false),
            AccountMeta::new(payer, true),
            AccountMeta::new(self.alloc_pda().0, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
        ];
        metas.extend(self.path_metas(&path, false).into_iter().map(|m| AccountMeta::new(m.pubkey, false)));
        for s in spares { metas.push(AccountMeta::new(s, false)); }
        Some(Instruction::new_with_bytes(self.program, &data, metas))
    }

    /// InitTree. `rent_hdr`/`rent_alloc` from the caller's client.
    pub fn init_tree_ix(&self, payer: Pubkey, value_size: u16, fanout: u16, rent_hdr: u64, rent_alloc: u64) -> Instruction {
        let (hdr, hb) = self.header_pda();
        let (alc, ab) = self.alloc_pda();
        let mut data = vec![IX_INIT_TREE];
        data.extend_from_slice(&self.tree_id.to_le_bytes());
        data.push(hb); data.push(ab);
        data.extend_from_slice(&value_size.to_le_bytes());
        data.extend_from_slice(&fanout.to_le_bytes());
        data.extend_from_slice(&rent_hdr.to_le_bytes());
        data.extend_from_slice(&rent_alloc.to_le_bytes());
        Instruction::new_with_bytes(self.program, &data, vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(hdr, false),
            AccountMeta::new(alc, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
        ])
    }

    // ---- client-side reads (walk the tree off-chain; no transaction needed) ----

    /// In-order scan from the smallest key, up to `max` entries: (key, value) pairs.
    /// Walks the forward leaf chain via the AccountReader. For an orderbook this is
    /// the book in price-time order (best price first); take(1) = top of book.
    pub fn scan(&self, r: &dyn AccountReader, max: usize) -> Vec<([u8; 32], Vec<u8>)> {
        let h = match self.header(r) { Some(h) if h.height > 0 => h, _ => return vec![] };
        let (f, vs) = (h.fanout as usize, h.value_size as usize);
        let voff = NODE_HDR + (f + 1) * KEY_SIZE;
        let mut idx = h.leftmost;
        let mut out = Vec::new();
        while idx != 0 && out.len() < max {
            let d = match r.account_data(&self.node_pda(idx).0) { Some(d) => d, None => break };
            let cnt = rd_u16(&d, N_KEY_COUNT) as usize;
            for i in 0..cnt {
                if out.len() >= max { break; }
                let key: [u8; 32] = d[NODE_HDR + i * KEY_SIZE..NODE_HDR + i * KEY_SIZE + KEY_SIZE].try_into().unwrap();
                let val = d[voff + i * vs..voff + i * vs + vs].to_vec();
                out.push((key, val));
            }
            idx = rd_u64(&d, N_NEXT_LEAF);
        }
        out
    }

    /// The smallest entry (top of book), or None if empty.
    pub fn best(&self, r: &dyn AccountReader) -> Option<([u8; 32], Vec<u8>)> {
        self.scan(r, 1).into_iter().next()
    }

    /// The value stored at `key`, or None if absent.
    pub fn get(&self, r: &dyn AccountReader, key: &[u8; 32]) -> Option<Vec<u8>> {
        let h = self.header(r)?;
        if h.height == 0 { return None; }
        let leaf = *self.path(r, key)?.last()?;
        let d = r.account_data(&self.node_pda(leaf).0)?;
        let (f, vs) = (h.fanout as usize, h.value_size as usize);
        let cnt = rd_u16(&d, N_KEY_COUNT) as usize;
        let (mut lo, mut hi) = (0usize, cnt);
        while lo < hi {
            let m = (lo + hi) / 2;
            if &d[NODE_HDR + m * KEY_SIZE..NODE_HDR + m * KEY_SIZE + KEY_SIZE] < &key[..] { lo = m + 1; } else { hi = m; }
        }
        if lo < cnt && &d[NODE_HDR + lo * KEY_SIZE..NODE_HDR + lo * KEY_SIZE + KEY_SIZE] == &key[..] {
            let voff = NODE_HDR + (f + 1) * KEY_SIZE;
            Some(d[voff + lo * vs..voff + lo * vs + vs].to_vec())
        } else { None }
    }
}

/// Orderbook key convention (CLOB-specific; the core Tree is key-agnostic).
///
/// A 32-byte order key that sorts to price-time priority: asks ascending price, bids
/// descending price; ties broken by slot (approximate FIFO), then a WRITER-UNIQUE
/// (maker, nonce) tail so two parallel makers never collide on a key. Strict global
/// FIFO is intentionally NOT used -- a shared sequence counter would serialize every
/// placement and destroy the parallelism (see orderbook-requirements.md D1).
pub mod keys {
    use solana_sdk::pubkey::Pubkey;

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum Side { Ask, Bid }

    pub fn order_key(side: Side, price: u64, slot: u64, maker: &Pubkey, nonce: u64) -> [u8; 32] {
        let p = match side { Side::Ask => price, Side::Bid => u64::MAX - price };
        let mut k = [0u8; 32];
        k[0..8].copy_from_slice(&p.to_be_bytes());
        k[8..16].copy_from_slice(&slot.to_be_bytes());
        k[16..24].copy_from_slice(&maker.to_bytes()[0..8]);
        k[24..32].copy_from_slice(&nonce.to_be_bytes());
        k
    }
    pub fn price_of(side: Side, key: &[u8; 32]) -> u64 {
        let p = u64::from_be_bytes(key[0..8].try_into().unwrap());
        match side { Side::Ask => p, Side::Bid => u64::MAX - p }
    }
    pub fn slot_of(key: &[u8; 32]) -> u64 { u64::from_be_bytes(key[8..16].try_into().unwrap()) }
}

#[cfg(test)]
mod tests {
    use super::keys::*;
    use solana_sdk::pubkey::Pubkey;

    #[test]
    fn order_key_price_time_priority() {
        let m = Pubkey::new_unique();
        // asks: lower price sorts first (better ask = lower)
        assert!(order_key(Side::Ask, 100, 5, &m, 0) < order_key(Side::Ask, 200, 5, &m, 0));
        // bids: higher price sorts first (better bid = higher)
        assert!(order_key(Side::Bid, 200, 5, &m, 0) < order_key(Side::Bid, 100, 5, &m, 0));
        // within a price: earlier slot (FIFO) sorts first
        assert!(order_key(Side::Ask, 100, 1, &m, 0) < order_key(Side::Ask, 100, 9, &m, 0));
        // roundtrip
        let a = order_key(Side::Ask, 12345, 7, &m, 3);
        assert_eq!(price_of(Side::Ask, &a), 12345);
        assert_eq!(slot_of(&a), 7);
        assert_eq!(price_of(Side::Bid, &order_key(Side::Bid, 999, 0, &m, 0)), 999);
    }
}

