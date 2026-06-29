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
