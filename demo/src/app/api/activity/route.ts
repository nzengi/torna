// Cached server read of recent orderbook activity (decoded place/cancel/match). The browser polls this
// instead of running getSignaturesForAddress + getTransaction itself, which is the heaviest RPC load.
// Each decoded tx is cached by signature, so only NEW signatures are fetched; the list has a short TTL.
import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import market from "@/lib/market.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const TTL_MS = 12_000;
const conn = new Connection(RPC, "confirmed");
const OB = new PublicKey(market.orderbookProgramId);
const ASK = 0, BID = 1;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return new Uint8Array();
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
const u64le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

interface Decoded { op: number; isBuy: boolean; price?: string; size?: string }
async function decodeOne(sig: string): Promise<Decoded | null> {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  const msg = tx.transaction.message as unknown as { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[]; compiledInstructions?: { programIdIndex: number; data: Uint8Array }[]; instructions?: { programIdIndex: number; data: string }[] };
  const keysArr = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const instrs = msg.compiledInstructions ?? msg.instructions ?? [];
  for (const ins of instrs) {
    if (keysArr[ins.programIdIndex]?.toBase58() === market.orderbookProgramId) {
      const d = ins.data as Uint8Array | string;
      const data = typeof d === "string" ? b58decode(d) : d;
      if (data.length < 1) return null;
      const op = data[0];
      if ((op === 0 || op === 2) && data.length >= 18) {
        const side = data[1];
        return { op, isBuy: op === 0 ? side === BID : side === ASK, price: u64le(data, 2).toString(), size: u64le(data, 10).toString() };
      }
      return { op, isBuy: false };
    }
  }
  return null;
}

interface Row { sig: string; slot: number; blockTime: number | null; err: boolean; op: number; isBuy: boolean; price?: string; size?: string }
const decodeCache = new Map<string, Decoded>();
let listCache: { at: number; rows: Row[] } | null = null;

export async function GET() {
  if (listCache && Date.now() - listCache.at < TTL_MS) {
    return NextResponse.json({ rows: listCache.rows }, { headers: { "cache-control": "public, max-age=10" } });
  }
  try {
    const sigs = await conn.getSignaturesForAddress(OB, { limit: 8 }, "confirmed");
    // Decode SEQUENTIALLY, not in a parallel burst: public devnet rate-limits many getTransaction calls
    // of the same method at once. Decoded results are cached by signature, so a warm instance only fetches
    // new signatures (usually 0-2 per poll), keeping steady-state load tiny.
    const rows: Row[] = [];
    for (const s of sigs) {
      let dec = decodeCache.get(s.signature);
      if (!dec) {
        try { const r = await decodeOne(s.signature); if (r) { decodeCache.set(s.signature, r); dec = r; } }
        catch { /* skip this one on a transient error; the rest still render */ }
      }
      if (dec) rows.push({ sig: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: !!s.err, ...dec });
    }
    if (decodeCache.size > 200) decodeCache.clear();
    // only replace the cache if we actually got something, so a partial 429 round doesn't blank the feed
    if (rows.length > 0 || !listCache) listCache = { at: Date.now(), rows };
    return NextResponse.json({ rows: listCache!.rows }, { headers: { "cache-control": "public, max-age=10" } });
  } catch (e) {
    if (listCache) return NextResponse.json({ rows: listCache.rows });
    return NextResponse.json({ rows: [], error: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120) });
  }
}
