// bankrun end-to-end: the TS SDK's instructions run against the REAL engine (torna.so),
// the direct analog of the Rust sdktest. We init a tree, cold-insert, hot insert/update/
// delete, and read back via the off-chain planner (get/scan) -- all through the TS SDK.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { Tree, type AccountReader } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
process.env.RUST_LOG ??= "error"; // quiet the runtime DEBUG spam
// torna.so is found by name in SBF_OUT_DIR (solana-program-test's file search)
process.env.SBF_OUT_DIR = resolve(here, "..", "..", "sbf", "out");

const { start } = await import("solana-bankrun");

const VS = 8; // 8-byte values
const F = 8; // fanout

function k32(n: number): Uint8Array {
  const k = new Uint8Array(32);
  new DataView(k.buffer).setUint32(28, n, false); // big-endian -> numeric sort
  return k;
}
function val(n: number): Uint8Array {
  const v = new Uint8Array(8);
  new DataView(v.buffer).setBigUint64(0, BigInt(n), false);
  return v;
}
const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString("hex") : null);

test("TS SDK drives the real engine end-to-end (bankrun)", async () => {
  const programId = new PublicKey(new Uint8Array(32).fill(9));
  const ctx = await start([{ name: "torna", programId }], []);
  const client = ctx.banksClient;
  const payer = ctx.payer;
  const rent = await client.getRent();

  const reader: AccountReader = {
    async accountData(key: PublicKey) {
      const a = await client.getAccount(key);
      return a ? Uint8Array.from(a.data) : null;
    },
  };
  const send = async (ix: any, signers: Keypair[] = [payer]) => {
    const tx = new Transaction();
    tx.recentBlockhash = ctx.lastBlockhash;
    tx.feePayer = payer.publicKey;
    tx.add(ix);
    tx.sign(...signers);
    return client.processTransaction(tx);
  };

  const tree = new Tree(programId, payer.publicKey, 1);

  // init (authority = payer)
  const rentHdr = rent.minimumBalance(146n);
  const rentAlloc = rent.minimumBalance(32n);
  await send(tree.initTreeIx(payer.publicKey, VS, F, rentHdr, rentAlloc));
  const h0 = await tree.header(reader);
  assert.ok(h0, "header exists after init");
  assert.equal(h0!.height, 0, "tree starts empty");
  assert.equal(h0!.fanout, F);
  assert.equal(h0!.valueSize, VS);

  const nodeSize = h0!.nodeSize;
  const rentNode = rent.minimumBalance(BigInt(nodeSize));

  // first insert is COLD (empty tree -> creates the root leaf)
  const coldIx = await tree.insertIx(reader, payer.publicKey, k32(50), val(500), rentNode);
  assert.ok(coldIx, "cold insert ix resolved");
  await send(coldIx!);
  assert.equal(hex(await tree.get(reader, k32(50))), hex(val(500)), "cold-inserted key reads back");

  // subsequent inserts are HOT (InsertFast)
  for (const n of [20, 80, 10, 60]) {
    const ix = await tree.insertFastIx(reader, payer.publicKey, k32(n), val(n * 10));
    assert.ok(ix, `insertFast ix for ${n}`);
    await send(ix!);
  }
  for (const n of [20, 80, 10, 60, 50]) {
    assert.equal(hex(await tree.get(reader, k32(n))), hex(val(n === 50 ? 500 : n * 10)), `get ${n}`);
  }

  // UpdateFast in place
  const upd = await tree.updateFastIx(reader, payer.publicKey, k32(20), val(2222));
  await send(upd!);
  assert.equal(hex(await tree.get(reader, k32(20))), hex(val(2222)), "update took effect");

  // DeleteFast
  const del = await tree.deleteFastIx(reader, payer.publicKey, k32(80));
  await send(del!);
  assert.equal(await tree.get(reader, k32(80)), null, "deleted key is gone");

  // scan returns the remaining keys in ascending (numeric) order
  const scanned = await tree.scan(reader, 100);
  const nums = scanned.map((e) => new DataView(e.key.buffer, e.key.byteOffset).getUint32(28, false));
  assert.deepEqual(nums, [10, 20, 50, 60], "scan is in-order, post delete");
  // best == smallest
  const best = await tree.best(reader);
  assert.equal(new DataView(best!.key.buffer, best!.key.byteOffset).getUint32(28, false), 10, "best = smallest");

  // a missing key reads null
  assert.equal(await tree.get(reader, k32(999)), null, "absent key -> null");
});

// The first e2e never exceeds height 1 (5 keys in a fanout-8 leaf), so the planner's
// MOST complex code -- multi-level descent in path(), the cold SPLIT account set, deleteIx
// sibling resolution, findIx, scanAccounts, coldPlan -- was entirely unexercised. This
// drives a genuinely multi-level tree (forced splits) through the real engine so a
// regression in any of those paths fails here instead of silently shipping. (round-1 gaps)
test("TS planner drives a MULTI-LEVEL tree (split / find / delete-rebalance)", async () => {
  const programId = new PublicKey(new Uint8Array(32).fill(7));
  const ctx = await start([{ name: "torna", programId }], []);
  const client = ctx.banksClient;
  const payer = ctx.payer;
  const rent = await client.getRent();

  const reader: AccountReader = {
    async accountData(key: PublicKey) {
      const a = await client.getAccount(key);
      return a ? Uint8Array.from(a.data) : null;
    },
  };
  // tryProcessTransaction returns the error (result string) instead of throwing
  const sendTry = async (ix: any, signers: Keypair[] = [payer]) => {
    const tx = new Transaction();
    tx.recentBlockhash = ctx.lastBlockhash;
    tx.feePayer = payer.publicKey;
    tx.add(ix);
    tx.sign(...signers);
    return client.tryProcessTransaction(tx);
  };
  const ok = (res: any, msg: string) => assert.equal(res.result, null, `${msg}: ${res.result}`);

  const tree = new Tree(programId, payer.publicKey, 2);
  ok(await sendTry(tree.initTreeIx(payer.publicKey, VS, F, rent.minimumBalance(146n), rent.minimumBalance(32n))), "init");
  const rentNode = rent.minimumBalance(BigInt((await tree.header(reader))!.nodeSize));

  // Place keys via the DOCUMENTED hot-then-cold flow: try InsertFast; on ERR_NEED_SPLIT_SLOT
  // (102 = 0x66, leaf full) fall back to the cold split path. The empty-tree first insert
  // fails InsertFast with a different code and also falls through to cold.
  const N = 25;
  const nums = Array.from({ length: N }, (_, i) => i + 1);
  let splits = 0;
  for (const n of nums) {
    const fastRes = await sendTry((await tree.insertFastIx(reader, payer.publicKey, k32(n), val(n * 10)))!);
    if (fastRes.result === null) continue; // hot insert landed
    if (fastRes.result.includes("0x66")) splits++; // genuine NEED_SPLIT_SLOT
    ok(await sendTry((await tree.insertIx(reader, payer.publicKey, k32(n), val(n * 10), rentNode))!), `cold insert ${n}`);
  }
  assert.ok(splits >= 2, `cold split path exercised (${splits} splits)`);

  // multi-level: height must have grown past 1, so path()'s descent loop ran for real
  const h = (await tree.header(reader))!;
  assert.ok(h.height >= 2, `tree is multi-level (height=${h.height})`);
  assert.equal(h.authority.toBase58(), payer.publicKey.toBase58(), "parseHeader.authority offset");

  // every key reads back via the multi-level off-chain planner, in sorted order
  for (const n of nums) assert.equal(hex(await tree.get(reader, k32(n))), hex(val(n * 10)), `get ${n} (multi-level)`);
  const scanNums = (await tree.scan(reader, 1000)).map((e) => new DataView(e.key.buffer, e.key.byteOffset).getUint32(28, false));
  assert.deepEqual(scanNums, nums, "scan spans multiple leaves, fully ordered");
  // scan's max-truncation early-stop, across the multi-leaf chain (not just the first leaf)
  const head3 = (await tree.scan(reader, 3)).map((e) => new DataView(e.key.buffer, e.key.byteOffset).getUint32(28, false));
  assert.deepEqual(head3, [1, 2, 3], "scan honors max across leaves");

  // findIx: the ON-CHAIN Find instruction (never sent before). return_data = [found, value..]
  const present = await sendTry((await tree.findIx(reader, k32(12)))!);
  ok(present, "findIx present");
  assert.equal(present.meta!.returnData!.data[0], 1, "find: found flag");
  assert.equal(hex(present.meta!.returnData!.data.slice(1)), hex(val(120)), "find: value");
  const absent = await sendTry((await tree.findIx(reader, k32(99)))!);
  assert.equal(absent.meta!.returnData!.data[0], 0, "find: absent flag");

  // scanAccounts must equal header + the actual leftmost->next_leaf chain of leaf PDAs
  const accs = (await tree.scanAccounts(reader, 1000)).map((p) => p.toBase58());
  const want = [tree.headerPda()[0].toBase58()];
  {
    let idx = h.leftmost;
    while (idx !== 0n) {
      want.push(tree.nodePda(idx)[0].toBase58());
      const d = (await reader.accountData(tree.nodePda(idx)[0]))!;
      idx = new DataView(d.buffer, d.byteOffset).getBigUint64(20, true); // N_NEXT_LEAF
    }
  }
  assert.deepEqual(accs, want, "scanAccounts = header + full leaf chain");

  // coldPlan must match the path + spares insertIx actually embeds (the ERR_NEED_SPLIT_SLOT
  // fallback resolver and the builder must agree, or a cold place references wrong accounts)
  const plan = (await tree.coldPlan(reader, k32(13)))!;
  assert.equal(plan.spares.length, h.height + 2, "coldPlan spares = height+2");
  const ci = (await tree.insertIx(reader, payer.publicKey, k32(13), val(130), rentNode))!;
  const planPath = plan.path.map((n) => tree.nodePda(n)[0].toBase58());
  const planSpares = plan.spares.map(([pk]) => pk.toBase58());
  const embedded = ci.keys.slice(4).map((k) => k.pubkey.toBase58()); // after header,payer,alloc,system
  assert.deepEqual(embedded, [...planPath, ...planSpares], "coldPlan path+spares == insertIx account set");

  // deleteIx (cold rebalance, primary-only). Exercise BOTH sibling branches of the planner's
  // sibling resolution -- a wrong side byte / sibling index makes the engine reject the tx or
  // corrupt order, caught by `ok(...)` + the post-delete scan.
  // (1) HIGH end first: the rightmost leaf underflows -> borrow/merge with its LEFT sibling
  //     (deleteIx sides=2 branch), while the tree is still multi-level.
  for (let n = 25; n >= 19; n--) {
    ok(await sendTry((await tree.deleteIx(reader, payer.publicKey, k32(n)))!), `deleteIx high ${n}`);
    assert.equal(await tree.get(reader, k32(n)), null, `deleted ${n} gone`);
  }
  assert.ok((await tree.header(reader))!.height >= 2, "still multi-level after the left-sibling pass");
  // (2) LOW end: the leftmost leaf underflows -> borrow/merge with its RIGHT sibling (sides=1),
  //     cascading until the root collapses back toward height 1.
  for (let n = 1; n <= 12; n++) {
    ok(await sendTry((await tree.deleteIx(reader, payer.publicKey, k32(n)))!), `deleteIx low ${n}`);
    assert.equal(await tree.get(reader, k32(n)), null, `deleted ${n} gone`);
  }
  const remaining = (await tree.scan(reader, 1000)).map((e) => new DataView(e.key.buffer, e.key.byteOffset).getUint32(28, false));
  assert.deepEqual(remaining, nums.filter((n) => n >= 13 && n <= 18), "scan correct after both-sided rebalance");
  assert.ok((await tree.header(reader))!.height < h.height, "merges shrank the tree height");
});
