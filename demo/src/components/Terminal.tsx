"use client";

// Act 1 client shell: owns the live book poll + the selected demo identity, and wires the book,
// the trade panel, and the cancellable "your orders" list together so a tx refreshes the book.
import { useMemo, useState } from "react";
import { ASK, BID, type Side } from "@/lib/orderbook";
import { cancel } from "@/lib/actions";
import { useBook } from "@/lib/useBook";
import { demoKeypair, explorerTx, MARKET } from "@/lib/market";
import { OrderBook } from "./OrderBook";
import { Trade } from "./Trade";

export function Terminal() {
  const book = useBook();
  const [idIdx, setIdIdx] = useState(0);
  const me = MARKET.demos[idIdx]?.pubkey;
  const [cancelMsg, setCancelMsg] = useState<{ msg: string; sig?: string } | null>(null);

  const mine = useMemo(() => {
    const asks = book.asks.filter((o) => o.maker === me).map((o) => ({ ...o, side: ASK as Side }));
    const bids = book.bids.filter((o) => o.maker === me).map((o) => ({ ...o, side: BID as Side }));
    return [...asks, ...bids];
  }, [book.asks, book.bids, me]);

  const doCancel = async (side: Side, keyHex: string) => {
    setCancelMsg({ msg: "cancelling…" });
    try {
      const sig = await cancel(demoKeypair(idIdx), side, keyHex);
      setCancelMsg({ msg: "cancelled", sig });
      book.refresh();
    } catch (e) {
      setCancelMsg({ msg: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-1">
        <OrderBook asks={book.asks} bids={book.bids} loading={book.loading} error={book.error} mine={me} />
      </div>
      <div className="lg:col-span-1">
        <Trade identityIdx={idIdx} setIdentityIdx={setIdIdx} onDone={book.refresh} />
      </div>
      <div className="lg:col-span-1">
        <div className="rounded-lg border border-line bg-panel">
          <div className="border-b border-line px-4 py-2 text-sm font-medium">Your open orders</div>
          {mine.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">none for demo{idIdx}</div>}
          {mine.map((o) => (
            <div key={o.keyHex} className="flex items-center justify-between border-b border-line/60 px-4 py-2 text-sm last:border-0">
              <span className={`nums ${o.side === ASK ? "text-ask" : "text-bid"}`}>
                {o.side === ASK ? "ASK" : "BID"} {o.size.toString()}@{o.price.toString()}
              </span>
              <button
                onClick={() => doCancel(o.side, o.keyHex)}
                className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:border-ask hover:text-ask"
              >
                cancel
              </button>
            </div>
          ))}
          {cancelMsg && (
            <div className="px-4 py-2 text-xs text-muted">
              {cancelMsg.msg}
              {cancelMsg.sig && (
                <>
                  {" · "}
                  <a className="underline hover:text-fg" href={explorerTx(cancelMsg.sig)} target="_blank" rel="noreferrer">tx ↗</a>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
