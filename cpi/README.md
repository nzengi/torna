# torna-cpi

[![crates.io](https://img.shields.io/crates/v/torna-cpi.svg)](https://crates.io/crates/torna-cpi)
[![docs.rs](https://docs.rs/torna-cpi/badge.svg)](https://docs.rs/torna-cpi)
[![license](https://img.shields.io/crates/l/torna-cpi.svg)](https://github.com/nzengi/torna/blob/main/LICENSE)

On-chain CPI helpers for [Torna](https://github.com/nzengi/torna): let your own Solana program drive the
hot path of the Torna index (`insert_fast`, `update_fast`, `delete_fast`, and the cold `insert_cold`
split path) by forwarding the client-resolved accounts and signing as a book-authority PDA.

Torna is a parallel, ordered, on-chain index primitive for Solana: a sorted key to value B+ tree with
one node per account, so writes at different keys carry disjoint write sets and the Sealevel scheduler
commits them in the same slot. This crate is the on-chain integration layer; off-chain, your client
resolves the account set with [`torna-sdk`](https://crates.io/crates/torna-sdk).

This is the generalized, reusable form of the engine's `probe` program: a library linked into your
program, not a deployable program of its own. It is how the reference order book (TornaDEX) inserts and
cancels orders while enforcing escrow.

## Add it

```toml
[dependencies]
torna-cpi = "0.1"
solana-program = "3.0"
```

## Use

Inside your program, sign as your tree-authority PDA and forward the path accounts your client resolved
(via `torna-sdk`):

```rust
use torna_cpi;

// your program owns the tree as a PDA authority
let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];

torna_cpi::insert_fast(
    torna_program, // the Torna engine program account
    authority,     // your authority PDA (signs via seeds)
    header,        // the tree header account
    path,          // root..leaf path accounts (client-resolved)
    &key,          // 32-byte key
    &value,        // value bytes (value_size for this tree)
    &[seeds],
)?;
```

The hot-path account shape (header read-only, only the leaf writable) is what lets disjoint-key writes
from your program land in the same slot. `book_authority(owner, market_id)` derives the canonical
authority PDA. In-house adversarial-reviewed; external audit pending.

## License

MIT.
