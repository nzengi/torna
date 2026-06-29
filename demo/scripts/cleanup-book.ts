// Cancel leftover CROSSED orders (bid >= ask) owned by our demo identities, so the book shows a
// clean, uncrossed spread. Place never auto-matches, so test orders can rest crossed.
// Run: npx tsx scripts/cleanup-book.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Tree, keys, type AccountReader } from "torna-sdk";
import { ASK, BID, cancelIx, type Side } from "../src/lib/orderbook";

const M = JSON.parse(readFileSync(join(import.meta.dirname, "../src/lib/market.json"), "utf8"));
const conn = new Connection(process.env.RPC ?? M.rpcUrl, "confirmed");
const reader: AccountReader = { async accountData(k: PublicKey) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const torna = new PublicKey(M.tornaProgramId);
const orderbook = new PublicKey(M.orderbookProgramId);
const NODE_HDR = 44, KEY = 32;
const kpByPubkey = new Map<string, Keypair>(M.demos.map((d: { pubkey: string; secret: number[] }) => [d.pubkey, Keypair.fromSecretKey(Uint8Array.from(d.secret))]));

interface O { price: bigint; key: Uint8Array; maker: string; }
async function read(tree: Tree, side: Side): Promise<O[]> {
  const h = await tree.header(reader); if (!h) return [];
  const voff = NODE_HDR + (h.fanout + 1) * KEY;
  const out: O[] = []; let idx = h.leftmost; let g = 0;
  while (idx !== 0n && g++ < 64) {
    const d = await reader.accountData(tree.nodePda(idx)[0]); if (!d) break;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const cnt = dv.getUint16(2, true);
    for (let i = 0; i < cnt; i++) {
      const size = dv.getBigUint64(voff + i * h.valueSize + 32, false);
      if (size === 0n) continue;
      const key = d.slice(NODE_HDR + i * KEY, NODE_HDR + i * KEY + KEY);
      const maker = new PublicKey(d.subarray(voff + i * h.valueSize, voff + i * h.valueSize + 32)).toBase58();
      out.push({ price: keys.priceOf(side === ASK ? keys.Side.Ask : keys.Side.Bid, key), key, maker });
    }
    idx = dv.getBigUint64(20, true);
  }
  return out;
}

async function main() {
  const askT = new Tree(torna, new PublicKey(M.creator), M.askTreeId);
  const bidT = new Tree(torna, new PublicKey(M.creator), M.bidTreeId);
  const asks = await read(askT, ASK);
  const bids = await read(bidT, BID);
  const bestBid = bids.reduce((m, o) => (o.price > m ? o.price : m), 0n);
  const bestAsk = asks.reduce((m, o) => (o.price < m ? o.price : m), 1n << 62n);
  console.log("asks:", asks.map((o) => o.price).join(","), "| bids:", bids.map((o) => o.price).join(","));

  // crossed = ask priced <= some bid, or bid priced >= some ask
  const targets: { side: Side; o: O }[] = [
    ...asks.filter((o) => o.price <= bestBid).map((o) => ({ side: ASK as Side, o })),
    ...bids.filter((o) => o.price >= bestAsk).map((o) => ({ side: BID as Side, o })),
  ];
  if (targets.length === 0) { console.log("book already uncrossed — nothing to do"); return; }

  for (const { side, o } of targets) {
    const kp = kpByPubkey.get(o.maker);
    if (!kp) { console.log(`skip ${side === ASK ? "ASK" : "BID"} @${o.price} (maker ${o.maker.slice(0, 4)} not a demo identity)`); continue; }
    const tree = side === ASK ? askT : bidT;
    const vault = new PublicKey(side === ASK ? M.baseVault : M.quoteVault);
    const makerDst = getAssociatedTokenAddressSync(new PublicKey(side === ASK ? M.baseMint : M.quoteMint), kp.publicKey, true);
    const ix = await cancelIx({ reader, tree, orderbook, torna, marketId: BigInt(M.marketId), side, key: o.key, maker: kp.publicKey, vault, makerDst });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [kp], { commitment: "confirmed" });
    console.log(`cancelled ${side === ASK ? "ASK" : "BID"} @${o.price} (demo ${o.maker.slice(0, 4)})  tx ${sig.slice(0, 12)}…`);
  }

  const a2 = await read(askT, ASK), b2 = await read(bidT, BID);
  console.log("after  asks:", a2.map((o) => o.price).join(","), "| bids:", b2.map((o) => o.price).join(","));
}
main().catch((e) => { console.error(e); process.exit(1); });
