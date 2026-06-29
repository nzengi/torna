# @torna/sdk

TypeScript client SDK for [Torna](../) — the **PathPlanner**. You call insert / update /
delete / find with a 32-byte key; the planner reads the tree off-chain and produces a
ready `TransactionInstruction` with the exact account set. `node_idx`, bumps, paths, and
spares never leak out.

This is a 1:1 port of the Rust `torna-sdk`. The pure surface — `orderKey`, the PDA
derivations, and `initTreeIx` — is asserted **byte-for-byte** against the Rust SDK (golden
vectors). The full builder + planner surface (hot insert/update/delete, the cold split path,
multi-level descent, `findIx`, `deleteIx` rebalance, `scan`/`scanAccounts`/`coldPlan`) is
verified **end-to-end against the real engine** `torna.so` over a genuinely multi-level tree
(bankrun). Caller-supplied values are range/length-checked (Rust's `u64`/`u32`/`[u8;32]`
types do this for free; the TS port checks at runtime and throws). Targets
`@solana/web3.js` v1.

## Install

```
npm install @torna/sdk @solana/web3.js
```

Requirements: this is an **ESM-only** package (Node ≥18, or any bundler — Vite/webpack/esbuild;
`require()` from CommonJS is not supported). Like `@solana/web3.js` v1 it relies on the Node
`Buffer` global, so in a browser provide a `Buffer` polyfill.

## Use

Provide an `AccountReader` (anything that returns raw account bytes — an RPC `Connection`,
a cache, or bankrun):

```ts
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { Tree, keys, type AccountReader } from "@torna/sdk";

const connection = new Connection("https://api.devnet.solana.com");
const reader: AccountReader = {
  async accountData(key) {
    const info = await connection.getAccountInfo(key);
    return info ? Uint8Array.from(info.data) : null;
  },
};

const program = new PublicKey("<torna program id>");
const tree = new Tree(program, creator.publicKey, /* treeId */ 1);

// hot-path insert (header read-only, only the leaf writable -> parallelizable)
const key = keys.orderKey(keys.Side.Ask, 100n, slot, maker.publicKey, nonce);
const ix = await tree.insertFastIx(reader, authority.publicKey, key, value);
//                                          ^ authority signs as a READ-ONLY signer

// if the leaf is full the engine returns ERR_NEED_SPLIT_SLOT (102): fall back to the
// cold path, which resolves spare node accounts for the split:
const cold = await tree.insertIx(reader, payer.publicKey, key, value, rentNode);
```

Client-side reads walk the tree off-chain (no transaction):

```ts
const top = await tree.best(reader);              // top of book
const page = await tree.scan(reader, 16);          // first 16 in sorted order
const v = await tree.get(reader, key);             // value at a key, or null
```

`best`/`scan`/`get` are **point-in-time off-chain snapshots** and may be stale by the time a
transaction lands — the on-chain matcher re-reads each order's live size at settlement. Never
treat a read size as final; size a `Match` defensively and rely on the taker's `limit` price
(which this SDK does not build) as the real protection against a worse-than-expected fill.

### Staleness

Between resolving a path and the tx landing, a concurrent writer may split/merge a node
(`ERR_BAD_PATH`, 105). Re-resolve from fresh state and resubmit with `retry`; compare
`Header.structureEpoch` to detect it cheaply.

```ts
import { retry, done, stale, fatal } from "@torna/sdk";
const res = await retry(3, async () => {
  const ix = await tree.insertFastIx(reader, authority.publicKey, key, value);
  const err = await submit(ix!);            // your submit
  if (err === 105) return stale();          // path went stale -> re-resolve
  if (err) return fatal(err);
  return done(undefined);
});
```

## Develop

```
make ts        # from torna/: regenerate golden vectors (Rust) + build + test
# or, inside ts-sdk/:
npm run build
npm test       # golden-vector equivalence + bankrun e2e (needs ../sbf/out/torna.so)
```

Layout offsets, PDA seeds, and the wire format are FROZEN — see [`../../torna_docs/abi.md`](../../torna_docs/abi.md).
If the engine layout ever changes, the golden + bankrun tests fail here.
