# Torna

[![crates.io](https://img.shields.io/crates/v/torna-sdk.svg)](https://crates.io/crates/torna-sdk)
[![docs.rs](https://docs.rs/torna-sdk/badge.svg)](https://docs.rs/torna-sdk)
[![npm](https://img.shields.io/npm/v/torna-sdk.svg)](https://www.npmjs.com/package/torna-sdk)
[![license](https://img.shields.io/crates/l/torna-sdk.svg)](LICENSE)

The first parallel, ordered, on-chain index primitive for Solana: a sorted key to value store where
every B+ tree node lives in its own account, so writes at different keys carry disjoint write sets and
the Sealevel scheduler commits them in the same slot. It is a generic sorted index, not a matching
engine. The engine is written in C for SBF; **TornaDEX** is the reference order book built on it.

- **Live demo:** TornaDEX on devnet (see `demo/`)
- **SDK:** `torna-sdk` on [npm](https://www.npmjs.com/package/torna-sdk) (TypeScript) and [crates.io](https://crates.io/crates/torna-sdk) (Rust), byte-equivalent
- **Status:** deployed on devnet, in-house adversarial-reviewed to convergence, external audit pending

## Why

Sorted on-chain state with many concurrent writers (an order book, a liquidation queue, a leaderboard)
is hard on Solana because of three scarce resources: the per-transaction account budget, account-lock
parallelism, and rent. A single-account slab loses all three. A high-fanout B+ tree with one node per
account is near-optimal on all three: height about three (account budget), one node per account
(parallelism), and high fanout amortizes per-account rent. The moat is not the B+ tree, which is
textbook; it is this layout plus a client SDK that makes account resolution invisible.

## Layout

| Path | What it is | Language |
|---|---|---|
| `sbf/` | The Torna engine: the parallel ordered B+ tree, one node per account. 15 instructions. | C / SBF |
| `sdk/` | Rust client SDK: the PathPlanner, key-based instruction builders. | Rust |
| `ts-sdk/` | TypeScript SDK, a byte-equivalent 1:1 port, published as `torna-sdk`. | TypeScript |
| `cpi/` | `torna-cpi` crate: invoke_signed helpers so a program drives Torna as a PDA authority. | Rust |
| `orderbook/` | TornaDEX, the reference two-sided escrow CLOB built on Torna. | Rust / SBF |
| `cpi-probe/` | Composability proof: a program CPIs InsertFast and parallelism survives. | Rust / SBF |
| `bench/` | The parallelism benchmark on a real validator banking stage. | Rust |
| `integration/`, `test/` | LiteSVM integration, on-chain differential, fuzz, CU, host property tests. | Rust / C |
| `demo/` | The Next.js demo site: TornaDEX trading, docs, research, and a Torna-aware explorer. | TypeScript |

## Quickstart (SDK)

```
npm install torna-sdk @solana/web3.js   # TypeScript
cargo add torna-sdk solana-sdk           # Rust
```

```ts
import { Tree, keys } from "torna-sdk";

const tree = new Tree(program, creator, treeId);
const key  = keys.orderKey(keys.Side.Ask, price, slot, maker, nonce);

// the planner resolves the exact accounts off-chain
const ix = await tree.insertFastIx(reader, authority, key, value);
// node_idx / bump / path / spares: never touched by you
```

## Build and test

Add the Solana platform-tools to PATH, then from the repo root:

```
make test         # host unit + differential
make sbf          # build the on-chain program
make integration  # LiteSVM: smoke, inttest, cpitest, sdktest, obtest, alttest
make diff         # on-chain differential vs an oracle (8000 ops)
make fuzz FUZZ_ITERS=60000
make cu           # compute units at production scale
make all          # all of the above
make ts           # TS SDK: golden vectors + bankrun e2e
cd bench && ./run.sh   # the parallelism benchmark (real validator)
```

## Status and honesty

Deployed and live on devnet. The engine, SDK, and orderbook each went through in-house adversarial
review to convergence (rounds until two consecutive clean passes), with a token-conservation invariant
on the order book. This is not a substitute for an external audit, which is pending; do not treat as
production-audited. The upgrade-authority policy is not yet decided. See `demo/` for the live docs and a
research writeup.

## License

MIT. See [LICENSE](LICENSE).
