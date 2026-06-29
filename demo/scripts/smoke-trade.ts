// Validate the exact path the UI buttons use: a demo identity (sole signer + fee payer) places
// an order, it shows up in the book, then cancels it and it is gone. Run: npx tsx scripts/smoke-trade.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Tree, keys, type AccountReader } from "torna-sdk";
import { ASK, placeIx, cancelIx } from "../src/lib/orderbook";

const M = JSON.parse(readFileSync(join(import.meta.dirname, "../src/lib/market.json"), "utf8"));
const conn = new Connection(process.env.RPC ?? M.rpcUrl, "confirmed");
const reader: AccountReader = { async accountData(k: PublicKey) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const torna = new PublicKey(M.tornaProgramId);
const orderbook = new PublicKey(M.orderbookProgramId);
const askTree = new Tree(torna, new PublicKey(M.creator), M.askTreeId);

async function asks() {
  return (await askTree.scan(reader, 64))
    .map((e) => ({ price: keys.priceOf(keys.Side.Ask, e.key), size: new DataView(e.value.buffer, e.value.byteOffset).getBigUint64(32, false) }))
    .filter((o) => o.size > 0n);
}

async function main() {
  const maker = Keypair.fromSecretKey(Uint8Array.from(M.demos[0].secret));
  console.log("maker demo0:", maker.publicKey.toBase58());
  const PRICE = 107n, SIZE = 2n;

  const before = await asks();
  console.log("asks before:", before.map((o) => `${o.size}@${o.price}`).join(", "));

  const src = getAssociatedTokenAddressSync(new PublicKey(M.baseMint), maker.publicKey, true);
  const { ix, key } = await placeIx({
    reader, tree: askTree, orderbook, torna, marketId: BigInt(M.marketId),
    side: ASK, price: PRICE, size: SIZE, nonce: BigInt(Date.now()), maker: maker.publicKey, makerSrc: src, vault: new PublicKey(M.baseVault),
  });
  const sig1 = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [maker], { commitment: "confirmed" });
  console.log("PLACED 2@107, tx", sig1.slice(0, 16), "…");

  const mid = await asks();
  const found = mid.some((o) => o.price === PRICE);
  console.log("asks after place:", mid.map((o) => `${o.size}@${o.price}`).join(", "), found ? "[OK 107 present]" : "[FAIL]");

  const cix = await cancelIx({
    reader, tree: askTree, orderbook, torna, marketId: BigInt(M.marketId),
    side: ASK, key, maker: maker.publicKey, vault: new PublicKey(M.baseVault), makerDst: src,
  });
  const sig2 = await sendAndConfirmTransaction(conn, new Transaction().add(cix), [maker], { commitment: "confirmed" });
  console.log("CANCELLED, tx", sig2.slice(0, 16), "…");

  const after = await asks();
  const gone = !after.some((o) => o.price === PRICE);
  console.log("asks after cancel:", after.map((o) => `${o.size}@${o.price}`).join(", "), gone ? "[OK 107 gone]" : "[FAIL]");
  console.log(found && gone ? "\nSMOKE PASS: place + cancel work from a demo identity" : "\nSMOKE FAIL");
}
main().catch((e) => { console.error(e); process.exit(1); });
