# torna-sdk

The Rust client SDK for [Torna](https://github.com/nzengi/torna): the **PathPlanner**. You call
insert / update / delete / find with a 32-byte key; the planner reads the tree off-chain through an
`AccountReader` and produces a ready `solana_sdk::instruction::Instruction` with the exact account set.
`node_idx`, PDA bumps, the descent path, and split spares never leak out.

Torna is a parallel, ordered, on-chain index primitive for Solana: a sorted key to value B+ tree with
one node per account, so writes at different keys carry disjoint write sets and the Sealevel scheduler
commits them in the same slot. The on-chain engine is written in C for SBF; this crate is the off-chain
client. A byte-equivalent TypeScript port is published as [`torna-sdk`](https://www.npmjs.com/package/torna-sdk)
on npm.

## Add it

```toml
[dependencies]
torna-sdk = "0.1"
solana-sdk = "3.0"
```

## Use

Implement `AccountReader` over your transport (an RPC client, a cache, or LiteSVM in tests):

```rust
use solana_sdk::pubkey::Pubkey;
use torna_sdk::{AccountReader, Tree, keys};

struct Reader; // wrap your RPC client / cache
impl AccountReader for Reader {
    fn account_data(&self, key: &Pubkey) -> Option<Vec<u8>> {
        // fetch and return the raw account bytes for `key`
        unimplemented!()
    }
}

let reader = Reader;
let tree = Tree::new(program, creator, /* tree_id */ 1);

// build a key (the order book uses a price-time key; any sorted key works)
let key = keys::order_key(keys::Side::Ask, price, slot, &maker, nonce);

// the planner resolves the exact accounts off-chain
let ix = tree.insert_fast_ix(&reader, authority, &key, &value).unwrap();

// reads need no transaction
let top = tree.best(&reader);          // top of book
let page = tree.scan(&reader, 16);     // a page
let val = tree.get(&reader, &key);     // a single value
```

## What is in the box

- `Tree` with the hot-path builders (`insert_fast_ix`, `update_fast_ix`, `delete_fast_ix`, `find_ix`),
  the cold split / merge path (`insert_ix`, `delete_ix`, `cold_plan`), `init_tree_ix`, and off-chain
  reads (`best`, `scan`, `get`, `scan_accounts`, `header`, `path`).
- `keys`: `order_key`, `price_of`, `slot_of` for the order-book key encoding.
- `retry` / `Attempt` for the staleness model: re-resolve and retry when a concurrent split or merge
  invalidates a cached path.

The pure surface (key encoding, PDA derivations, `init_tree_ix`) is asserted byte-for-byte against the
on-chain ABI, and the full planner is verified end-to-end against the real engine over a multi-level
tree. In-house adversarial-reviewed; external audit pending.

## License

MIT.
