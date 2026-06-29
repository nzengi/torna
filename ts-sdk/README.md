# @torna/sdk

TypeScript client SDK for [Torna](../) — the **PathPlanner**. You call insert / update /
delete / find with a 32-byte key; the planner reads the tree off-chain and produces a
ready `TransactionInstruction` with the exact account set. `node_idx`, bumps, paths, and
spares never leak out.

This is a 1:1 port of the Rust `torna-sdk`, asserted **byte-for-byte** against it (golden
vectors) and **end-to-end** against the real engine `torna.so` (bankrun). Targets
`@solana/web3.js` v1.

## Install

```
npm install @torna/sdk @solana/web3.js
```

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
