// Cached server read of the live book. The browser polls THIS endpoint, not the RPC, so many viewers
// share one upstream read per TTL (a load-balancer effect) and the RPC is never hit "constantly".
// The RPC is server-only (RPC_URL env, defaults to public devnet) so no key is exposed to the browser.
import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { Tree, keys, type AccountReader } from "torna-sdk";
import market from "@/lib/market.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const TTL_MS = 10_000;

const conn = new Connection(RPC, "confirmed");
const reader: AccountReader = {
  async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; },
};
const torna = new PublicKey(market.tornaProgramId);
const creator = new PublicKey(market.creator);
const askTree = new Tree(torna, creator, market.askTreeId);
const bidTree = new Tree(torna, creator, market.bidTreeId);

interface OrderJSON { price: string; size: string; maker: string; keyHex: string }
function decode(side: typeof keys.Side.Ask | typeof keys.Side.Bid, e: { key: Uint8Array; value: Uint8Array }): OrderJSON {
  const dv = new DataView(e.value.buffer, e.value.byteOffset, e.value.byteLength);
  return {
    price: keys.priceOf(side, e.key).toString(),
    size: dv.getBigUint64(32, false).toString(),
    maker: new PublicKey(e.value.subarray(0, 32)).toBase58(),
    keyHex: Buffer.from(e.key).toString("hex"),
  };
}
async function scanSide(tree: Tree, side: typeof keys.Side.Ask | typeof keys.Side.Bid): Promise<OrderJSON[]> {
  const rows = await tree.scan(reader, 64);
  return rows.map((e) => decode(side, e)).filter((o) => o.size !== "0");
}

let cache: { at: number; data: { asks: OrderJSON[]; bids: OrderJSON[] } } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.data, { headers: { "cache-control": "public, max-age=8" } });
  }
  try {
    const [asks, bids] = await Promise.all([scanSide(askTree, keys.Side.Ask), scanSide(bidTree, keys.Side.Bid)]);
    cache = { at: Date.now(), data: { asks, bids } };
    return NextResponse.json(cache.data, { headers: { "cache-control": "public, max-age=8" } });
  } catch (e) {
    // serve the last good snapshot on a transient RPC error (e.g. a 429), instead of failing the UI
    if (cache) return NextResponse.json(cache.data, { headers: { "cache-control": "public, max-age=4" } });
    return NextResponse.json({ asks: [], bids: [], error: e instanceof Error ? e.message : String(e) });
  }
}
