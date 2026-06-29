// Pure unit tests for the input-validation guards and the staleness retry model -- the
// parts Rust's type system enforces for free but the TS port must check explicitly, plus
// the retry combinator (untested before). No engine/bankrun needed.

import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { Tree, retry, done, stale, fatal, type Attempt, type AccountReader } from "../src/index.js";
import { orderKey, priceOf, slotOf, Side } from "../src/keys.js";

const PROG = new PublicKey(new Uint8Array(32).fill(1));
const CREATOR = new PublicKey(new Uint8Array(32).fill(2));
const MAKER = new PublicKey(new Uint8Array(32).fill(3));
const U64_MAX = (1n << 64n) - 1n;

test("orderKey rejects out-of-range / wrong-type price, slot, nonce", () => {
  // boundary values are fine
  assert.doesNotThrow(() => orderKey(Side.Ask, 0n, 0n, MAKER, 0n));
  assert.doesNotThrow(() => orderKey(Side.Bid, U64_MAX, U64_MAX, MAKER, U64_MAX));
  // a 2^64 price would SILENTLY WRAP to 0 (top of book, instant fill) -- must throw instead
  assert.throws(() => orderKey(Side.Ask, 1n << 64n, 5n, MAKER, 0n), RangeError);
  assert.throws(() => orderKey(Side.Ask, -1n, 5n, MAKER, 0n), RangeError);
  assert.throws(() => orderKey(Side.Ask, 100n, 1n << 64n, MAKER, 0n), RangeError);
  assert.throws(() => orderKey(Side.Ask, 100n, 5n, MAKER, -1n), RangeError);
  // a `number` where a bigint is required is a common caller slip. Match the MESSAGE: a bare
  // `TypeError` assertion would pass even without the guard (100n-vs-number bitwise mix throws
  // its own TypeError downstream), so it must be the explicit "must be a bigint" guard.
  assert.throws(() => orderKey(Side.Ask, 100 as unknown as bigint, 5n, MAKER, 0n), /must be a bigint/);
});

test("priceOf / slotOf reject a wrong-length key", () => {
  const k = orderKey(Side.Ask, 12345n, 7n, MAKER, 3n);
  assert.equal(priceOf(Side.Ask, k), 12345n);
  assert.equal(slotOf(k), 7n);
  assert.throws(() => priceOf(Side.Ask, new Uint8Array(8)), RangeError);
  assert.throws(() => slotOf(new Uint8Array(31)), RangeError);
});

test("Tree constructor rejects an out-of-u32 / non-integer treeId", () => {
  assert.doesNotThrow(() => new Tree(PROG, CREATOR, 0));
  assert.doesNotThrow(() => new Tree(PROG, CREATOR, 2 ** 32 - 1));
  // 2^32 would truncate to the seed bytes of tree 0 -> instructions hit the WRONG tree
  assert.throws(() => new Tree(PROG, CREATOR, 2 ** 32), RangeError);
  assert.throws(() => new Tree(PROG, CREATOR, -1), RangeError);
  assert.throws(() => new Tree(PROG, CREATOR, 1.5), TypeError);
});

test("initTreeIx rejects out-of-u16 fanout / valueSize", () => {
  const t = new Tree(PROG, CREATOR, 1);
  assert.doesNotThrow(() => t.initTreeIx(MAKER, 40, 8, 1000n, 500n));
  assert.throws(() => t.initTreeIx(MAKER, 40, 65536, 1000n, 500n), RangeError); // fanout wraps to 0
  assert.throws(() => t.initTreeIx(MAKER, 1 << 16, 8, 1000n, 500n), RangeError); // valueSize wraps to 0
  assert.throws(() => t.initTreeIx(MAKER, 40, 8, -1n, 500n), RangeError); // rent out of u64
  // a `number` rent (forgot the `n` suffix) must hit the explicit u64 bigint guard
  assert.throws(() => t.initTreeIx(MAKER, 40, 8, 1000 as unknown as bigint, 500n), /must be a bigint/);
});

test("key-taking builders reject a wrong-length key at the path choke point", async () => {
  const t = new Tree(PROG, CREATOR, 1);
  // path() validates the key before any account read (assertKey is its first statement), so
  // every builder that resolves a path first rejects a wrong-length key even on a missing tree.
  const dummy: AccountReader = { async accountData() { return null; } };
  await assert.rejects(t.path(dummy, new Uint8Array(8)), RangeError);
  await assert.rejects(t.insertFastIx(dummy, MAKER, new Uint8Array(16), new Uint8Array(8)), RangeError);
  await assert.rejects(t.updateFastIx(dummy, MAKER, new Uint8Array(33), new Uint8Array(8)), RangeError);
  await assert.rejects(t.deleteFastIx(dummy, MAKER, new Uint8Array(0)), RangeError);
  await assert.rejects(t.findIx(dummy, new Uint8Array(64)), RangeError);
});

test("retry: done short-circuits, fatal short-circuits, stale re-resolves, exhaustion -> null", async () => {
  // done on first try
  assert.deepEqual(await retry(3, async () => done(42)), { ok: true, value: 42 });
  // succeeds on the 3rd attempt after two stale re-resolves
  let n = 0;
  const r = await retry<number>(5, async () => {
    n++;
    return n < 3 ? stale() : done(n);
  });
  assert.deepEqual(r, { ok: true, value: 3 });
  assert.equal(n, 3, "re-resolved exactly until success");
  // a fatal error stops immediately
  assert.deepEqual(await retry(5, async () => fatal("boom")), { ok: false, error: "boom" });
  // exhausting all attempts on persistent staleness returns null
  let calls = 0;
  const ex = await retry(2, async (): Promise<Attempt<number>> => {
    calls++;
    return stale();
  });
  assert.equal(ex, null);
  assert.equal(calls, 2, "tried exactly `attempts` times");
});
