"use client";

// A live snapshot of the on-chain book, read from devnet via the SDK. Proves the demo is real, right
// in the hero. Auto-refreshes through useBook.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useBook } from "@/lib/useBook";

export function LiveMarket() {
  const { asks, bids, loading, error } = useBook();
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const mid = bestAsk !== undefined && bestBid !== undefined ? (bestAsk + bestBid) / 2n : undefined;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;
  const count = asks.length + bids.length;
  const fmt = (v: bigint | undefined) => (v !== undefined ? v.toString() : "-");

  return (
    <div className="glass neon-glow rounded-2xl p-5">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-semibold text-fg">TornaDEX, live on devnet</span>
        <span className="flex items-center gap-1.5 text-xs text-faint">
          <span className={`h-1.5 w-1.5 rounded-full ${error ? "bg-ask" : "bg-bid"} ${loading ? "animate-pulse" : ""}`} aria-hidden />
          {error ? "rpc error" : loading ? "syncing" : "real book, real escrow"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Cell label="Best bid" value={fmt(bestBid)} cls="text-bid" />
        <Cell label="Mid" value={fmt(mid)} cls="text-fg" />
        <Cell label="Best ask" value={fmt(bestAsk)} cls="text-ask" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Cell label="Spread" value={fmt(spread)} cls="text-muted" />
        <Cell label="Resting orders" value={loading && count === 0 ? "-" : String(count)} cls="text-fg" />
      </div>
      <Link href="/trade" className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand transition-colors duration-100 hover:text-brand-hi">
        Open the trading terminal <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

function Cell({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel/60 p-3">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={`nums mt-0.5 text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}
