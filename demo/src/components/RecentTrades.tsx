"use client";

// Live market activity tape: polls the orderbook program's recent signatures and decodes each one
// from its instruction data (op + side + price + size, wire formats per lib/orderbook.ts) into a
// human row. Matches are real fills; places/cancels are book activity. Decoded results are cached by
// signature so each poll only fetches new transactions.
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { connection, explorerTx, MARKET } from "@/lib/market";

const ASK = 0, BID = 1;
const OB = new PublicKey(MARKET.orderbookProgramId);
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

interface Row { sig: string; op: number; isBuy: boolean; price?: bigint; size?: bigint; time: number | null; err: boolean; }
const OP_LABEL = ["place", "cancel", "match", "place", "init"];

function buildRow(sig: string, data: Uint8Array, time: number | null, err: boolean): Row {
  const op = data[0];
  if ((op === 0 || op === 2) && data.length >= 18) {
    const side = data[1];
    // place: BID side is a buy. match: taker hitting ASKs (bookSide=ASK) is a buy.
    const isBuy = op === 0 ? side === BID : side === ASK;
    return { sig, op, isBuy, price: u64le(data, 2), size: u64le(data, 10), time, err };
  }
  return { sig, op, isBuy: false, time, err };
}

async function decodeOne(conn: Connection, sig: string, time: number | null, err: boolean): Promise<Row | null> {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  const msg = tx.transaction.message as unknown as { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[]; compiledInstructions?: { programIdIndex: number; data: Uint8Array }[]; instructions?: { programIdIndex: number; data: string }[] };
  const keysArr = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const instrs = msg.compiledInstructions ?? msg.instructions ?? [];
  for (const ins of instrs) {
    if (keysArr[ins.programIdIndex]?.toBase58() === MARKET.orderbookProgramId) {
      const d = ins.data as Uint8Array | string;
      const data = typeof d === "string" ? b58decode(d) : d;
      if (data.length >= 1) return buildRow(sig, data, time, err);
    }
  }
  return null;
}

function ago(t: number | null): string {
  if (!t) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

export function RecentTrades() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const cache = useRef<Map<string, Row>>(new Map());

  const load = useCallback(async () => {
    try {
      const conn = connection();
      const sigs = await conn.getSignaturesForAddress(OB, { limit: 12 }, "confirmed");
      const out = await Promise.all(sigs.map(async (s) => {
        const c = cache.current.get(s.signature);
        if (c) return c;
        try {
          const row = await decodeOne(conn, s.signature, s.blockTime ?? null, !!s.err);
          if (row) cache.current.set(s.signature, row);
          return row;
        } catch { return null; }
      }));
      setRows(out.filter((r): r is Row => r !== null));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const id = setInterval(() => { if (!document.hidden) load(); }, 10000); return () => clearInterval(id); }, [load]);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-sm font-semibold text-fg">Recent trades</span>
        <span className="flex items-center gap-1.5 text-xs text-faint">{loading && <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />} live market activity</span>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-4 py-1.5 text-[11px] uppercase tracking-wide text-faint">
        <span>type</span><span>side / size @ price</span><span className="text-right">age</span><span></span>
      </div>
      <div className="divide-y divide-line/60">
        {rows.map((r) => (
          <a key={r.sig} href={explorerTx(r.sig)} target="_blank" rel="noreferrer" className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 px-4 py-2 text-sm transition-colors duration-100 hover:bg-panel-hi">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${r.op === 2 ? "bg-brand/10 text-brand" : "bg-panel-hi text-muted"}`}>{OP_LABEL[r.op] ?? "tx"}</span>
            {r.price !== undefined ? (
              <span className={`nums ${r.err ? "text-faint line-through" : r.isBuy ? "text-bid" : "text-ask"}`}>
                {r.isBuy ? "buy" : "sell"} {r.size?.toString()} @ {r.price.toString()}
              </span>
            ) : (
              <span className="text-faint">{r.op === 1 ? "order cancelled" : "transaction"}</span>
            )}
            <span className="nums text-right text-faint">{ago(r.time)}</span>
            <ExternalLink className="h-3 w-3 text-faint" aria-hidden />
          </a>
        ))}
        {!loading && rows.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">no recent activity</div>}
      </div>
    </div>
  );
}
