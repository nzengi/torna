// Top up a clean, deep, uncrossed ladder for the demo. Idempotent-ish: uses unique nonces.
// Run: npx tsx scripts/topup.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Tree, type AccountReader } from "torna-sdk";
import { ASK, BID, placeIx, type Side } from "../src/lib/orderbook";

const M = JSON.parse(readFileSync(join(import.meta.dirname, "../src/lib/market.json"), "utf8"));
const conn = new Connection(process.env.RPC ?? M.rpcUrl, "confirmed");
const reader: AccountReader = { async accountData(k: PublicKey) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const torna = new PublicKey(M.tornaProgramId);
const orderbook = new PublicKey(M.orderbookProgramId);
const askT = new Tree(torna, new PublicKey(M.creator), M.askTreeId);
const bidT = new Tree(torna, new PublicKey(M.creator), M.bidTreeId);
const kp = (i: number) => Keypair.fromSecretKey(Uint8Array.from(M.demos[i].secret));
const ata = (mint: string, owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);

// [demoIdx, side, price, size] — a tight, deep, uncrossed ladder (asks 102/104, bids 100/99)
const ORDERS: [number, Side, bigint, bigint][] = [
  [1, ASK, 102n, 4n],
  [0, ASK, 104n, 5n],
  [2, BID, 100n, 5n],
  [3, BID, 99n, 3n],
];

async function main() {
  let nonce = BigInt(Date.now());
  for (const [mi, side, price, size] of ORDERS) {
    const maker = kp(mi);
    const tree = side === ASK ? askT : bidT;
    const src = side === ASK ? ata(M.baseMint, maker.publicKey) : ata(M.quoteMint, maker.publicKey);
    const vault = new PublicKey(side === ASK ? M.baseVault : M.quoteVault);
    const { ix } = await placeIx({ reader, tree, orderbook, torna, marketId: BigInt(M.marketId), side, price, size, nonce: nonce++, maker: maker.publicKey, makerSrc: src, vault });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [maker], { commitment: "confirmed" });
    console.log(`placed ${side === ASK ? "ASK" : "BID"} ${size}@${price} (demo${mi})  tx ${sig.slice(0, 12)}…`);
  }
  console.log("done");
}
main().catch((e) => { console.error(e); process.exit(1); });
