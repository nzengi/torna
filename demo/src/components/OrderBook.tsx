"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Order } from "@/lib/useBook";

function Row({ o, side, max, mine }: { o: Order; side: "ask" | "bid"; max: bigint; mine: boolean }) {
  const pct = max > 0n ? Number((o.size * 100n) / max) : 0;
  const color = side === "ask" ? "text-ask" : "text-bid";
  const bar = side === "ask" ? "bg-ask/10" : "bg-bid/10";
  return (
    <div className="relative grid grid-cols-3 px-4 py-1 text-sm">
      <div
        className="absolute inset-y-0 right-0 transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%` }}
      >
        <div className={`h-full w-full ${bar}`} />
      </div>
      <span className={`nums relative ${color}`}>
        {mine && <span className="mr-1 text-parallel" aria-label="your order">●</span>}
        {o.price.toString()}
      </span>
      <span className="nums relative text-right text-fg">{o.size.toString()}</span>
      <span className="nums relative text-right text-faint">{o.maker.slice(0, 4)}…</span>
    </div>
  );
}

// flash the cell in the direction the price moved, then fade to neutral (Solana "numbers that move")
function useFlash(value: bigint | undefined): string {
  const prev = useRef<bigint | undefined>(undefined);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (value === undefined) return;
    if (prev.current !== undefined && value !== prev.current) {
      setCls(value > prev.current ? "tick-up" : "tick-down");
      const t = setTimeout(() => setCls(""), 650);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return cls;
}

function SkeletonRows() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="grid grid-cols-3 gap-2 px-4 py-1.5">
          <div className="h-3 rounded bg-panel-hi" />
          <div className="h-3 rounded bg-panel-hi" />
          <div className="h-3 rounded bg-panel-hi" />
        </div>
      ))}
    </div>
  );
}

export function OrderBook({
  asks, bids, loading, error, mine, onRetry,
}: {
  asks: Order[]; bids: Order[]; loading: boolean; error: string | null; mine?: string; onRetry?: () => void;
}) {
  const max = [...asks, ...bids].reduce((m, o) => (o.size > m ? o.size : m), 0n);
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;
  const askFlash = useFlash(bestAsk);
  const bidFlash = useFlash(bestBid);
  const firstLoad = loading && asks.length === 0 && bids.length === 0;

  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="text-sm font-medium">Order book</span>
        <span className="flex items-center gap-1.5 text-xs text-faint">
          {loading && <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />}
          {loading ? "syncing" : "live · base/quote"}
        </span>
      </div>
      <div className="grid grid-cols-3 px-4 py-1.5 text-[11px] uppercase tracking-wide text-faint">
        <span>price</span>
        <span className="text-right">size</span>
        <span className="text-right">maker</span>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-ask">
          <span>RPC error: {error}</span>
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 text-muted transition-colors duration-100 hover:border-muted hover:text-fg"
            >
              <RefreshCw className="h-3 w-3" aria-hidden /> Retry
            </button>
          )}
        </div>
      ) : firstLoad ? (
        <SkeletonRows />
      ) : (
        <>
          <div className="flex flex-col-reverse">
            {asks.map((o) => (
              <Row key={o.keyHex} o={o} side="ask" max={max} mine={o.maker === mine} />
            ))}
          </div>

          <div className="flex items-center justify-between border-y border-line bg-panel-hi px-4 py-2 text-sm">
            <span className={`nums text-bid ${bidFlash}`}>{bestBid?.toString() ?? "—"}</span>
            <span className="text-xs text-faint">
              spread {spread !== undefined ? <span className="nums text-muted">{spread.toString()}</span> : "—"}
            </span>
            <span className={`nums text-ask ${askFlash}`}>{bestAsk?.toString() ?? "—"}</span>
          </div>

          <div>
            {bids.map((o) => (
              <Row key={o.keyHex} o={o} side="bid" max={max} mine={o.maker === mine} />
            ))}
          </div>

          {asks.length === 0 && bids.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-faint">Book empty — place the first order.</div>
          )}
        </>
      )}
    </div>
  );
}
