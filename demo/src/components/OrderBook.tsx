"use client";

import type { Order } from "@/lib/useBook";

function Row({ o, side, max, mine }: { o: Order; side: "ask" | "bid"; max: bigint; mine: boolean }) {
  const pct = max > 0n ? Number((o.size * 100n) / max) : 0;
  const color = side === "ask" ? "text-ask" : "text-bid";
  const bar = side === "ask" ? "bg-ask/10" : "bg-bid/10";
  return (
    <div className="relative grid grid-cols-3 px-4 py-1 text-sm">
      <div className={`absolute inset-y-0 right-0 ${bar}`} style={{ width: `${pct}%` }} />
      <span className={`nums relative ${color}`}>
        {mine && <span className="mr-1 text-parallel">●</span>}
        {o.price.toString()}
      </span>
      <span className="nums relative text-right text-fg">{o.size.toString()}</span>
      <span className="nums relative text-right text-faint">{o.maker.slice(0, 4)}…</span>
    </div>
  );
}

export function OrderBook({
  asks, bids, loading, error, mine,
}: {
  asks: Order[]; bids: Order[]; loading: boolean; error: string | null; mine?: string;
}) {
  const max = [...asks, ...bids].reduce((m, o) => (o.size > m ? o.size : m), 0n);
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;

  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="text-sm font-medium">Order book</span>
        <span className="text-xs text-faint">{loading ? "syncing…" : "live · base/quote"}</span>
      </div>
      <div className="grid grid-cols-3 px-4 py-1.5 text-[11px] uppercase tracking-wide text-faint">
        <span>price</span>
        <span className="text-right">size</span>
        <span className="text-right">maker</span>
      </div>

      {error && <div className="px-4 py-3 text-xs text-ask">RPC error: {error}</div>}

      <div className="flex flex-col-reverse">
        {asks.map((o) => (
          <Row key={o.keyHex} o={o} side="ask" max={max} mine={o.maker === mine} />
        ))}
      </div>

      <div className="flex items-center justify-between border-y border-line bg-panel-hi px-4 py-2 text-sm">
        <span className="nums text-bid">{bestBid?.toString() ?? "—"}</span>
        <span className="text-xs text-faint">
          spread {spread !== undefined ? <span className="nums text-muted">{spread.toString()}</span> : "—"}
        </span>
        <span className="nums text-ask">{bestAsk?.toString() ?? "—"}</span>
      </div>

      <div>
        {bids.map((o) => (
          <Row key={o.keyHex} o={o} side="bid" max={max} mine={o.maker === mine} />
        ))}
      </div>

      {!loading && asks.length === 0 && bids.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-faint">book empty</div>
      )}
    </div>
  );
}
