"use client";

// Live market activity tape. Reads decoded recent orderbook txns from the cached /api/activity endpoint
// (the server does the getSignaturesForAddress + getTransaction once per TTL), so the browser never runs
// that heavy RPC load itself.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { explorerTx } from "@/lib/market";

interface Row { sig: string; slot: number; blockTime: number | null; err: boolean; op: number; isBuy: boolean; price?: string; size?: string }
const OP_LABEL = ["place", "cancel", "match", "place", "init"];

function ago(t: number | null): string {
  if (!t) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

export function RecentTrades() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      const j = await res.json();
      setRows(j.rows ?? []);
    } catch { /* keep last */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const id = setInterval(() => { if (!document.hidden) load(); }, 20000); return () => clearInterval(id); }, [load]);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-sm font-semibold text-fg">Recent activity</span>
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
                {r.isBuy ? "buy" : "sell"} {r.size} @ {r.price}
              </span>
            ) : (
              <span className="text-faint">{r.op === 1 ? "order cancelled" : "transaction"}</span>
            )}
            <span className="nums text-right text-faint">{ago(r.blockTime)}</span>
            <ExternalLink className="h-3 w-3 text-faint" aria-hidden />
          </a>
        ))}
        {!loading && rows.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">no recent activity</div>}
      </div>
    </div>
  );
}
