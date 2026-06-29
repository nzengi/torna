"use client";

import { useState } from "react";
import { ASK, BID, type Side } from "@/lib/orderbook";
import { place, take } from "@/lib/actions";
import { MARKET, demoKeypair, explorerTx, shorten } from "@/lib/market";

type Toast = { kind: "pending" | "ok" | "err"; msg: string; sig?: string } | null;

export function Trade({
  identityIdx, setIdentityIdx, onDone,
}: {
  identityIdx: number; setIdentityIdx: (i: number) => void; onDone: () => void;
}) {
  const [tab, setTab] = useState<"place" | "take">("place");
  const [side, setSide] = useState<Side>(ASK);
  const [price, setPrice] = useState("105");
  const [size, setSize] = useState("3");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const run = async (fn: () => Promise<string | null>, label: string) => {
    setBusy(true);
    setToast({ kind: "pending", msg: `${label} …` });
    try {
      const sig = await fn();
      if (sig === null) setToast({ kind: "err", msg: "no crossing orders" });
      else setToast({ kind: "ok", msg: `${label} confirmed`, sig });
      onDone();
    } catch (e) {
      setToast({ kind: "err", msg: e instanceof Error ? e.message.slice(0, 140) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const maker = () => demoKeypair(identityIdx);
  const doPlace = () => run(() => place(maker(), side, BigInt(price), BigInt(size)), `place ${side === ASK ? "ask" : "bid"} ${size}@${price}`);
  const doTake = () => run(async () => {
    const r = await take(maker(), side, BigInt(price), BigInt(size));
    return r ? r.sig : null;
  }, `${side === ASK ? "buy" : "sell"} ${size} @ limit ${price}`);

  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="border-b border-line px-4 py-2 text-sm font-medium">Trade</div>

      {/* identity */}
      <div className="border-b border-line px-4 py-3">
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-faint">acting as (devnet demo identity)</div>
        <div className="flex flex-wrap gap-1.5">
          {MARKET.demos.map((d, i) => (
            <button
              key={d.pubkey}
              onClick={() => setIdentityIdx(i)}
              className={`nums rounded border px-2 py-1 text-xs ${
                i === identityIdx ? "border-brand text-brand" : "border-line text-muted hover:border-muted"
              }`}
            >
              demo{i} {shorten(d.pubkey)}
            </button>
          ))}
        </div>
      </div>

      {/* tabs */}
      <div className="flex border-b border-line text-sm">
        {(["place", "take"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 ${tab === t ? "border-b-2 border-brand text-fg" : "text-faint hover:text-muted"}`}
          >
            {t === "place" ? "Place (maker)" : "Take (taker)"}
          </button>
        ))}
      </div>

      <div className="space-y-3 px-4 py-4">
        <div className="flex gap-2">
          <button
            onClick={() => setSide(ASK)}
            className={`flex-1 rounded border py-1.5 text-sm ${side === ASK ? "border-ask text-ask" : "border-line text-muted"}`}
          >
            {tab === "place" ? "Sell (ask)" : "Buy (hit asks)"}
          </button>
          <button
            onClick={() => setSide(BID)}
            className={`flex-1 rounded border py-1.5 text-sm ${side === BID ? "border-bid text-bid" : "border-line text-muted"}`}
          >
            {tab === "place" ? "Buy (bid)" : "Sell (hit bids)"}
          </button>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-faint">{tab === "place" ? "price" : "limit price"}</span>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
            className="nums mt-1 w-full rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-faint">size</span>
          <input
            value={size}
            onChange={(e) => setSize(e.target.value.replace(/\D/g, ""))}
            className="nums mt-1 w-full rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-brand"
          />
        </label>

        <button
          disabled={busy || !price || !size}
          onClick={tab === "place" ? doPlace : doTake}
          className="w-full rounded bg-brand py-2 text-sm font-medium text-bg hover:bg-brand-hi disabled:opacity-40"
        >
          {busy ? "submitting…" : tab === "place" ? "Place order" : "Take"}
        </button>

        {toast && (
          <div
            className={`rounded border px-3 py-2 text-xs ${
              toast.kind === "ok" ? "border-bid/40 text-bid" : toast.kind === "err" ? "border-ask/40 text-ask" : "border-line text-muted"
            }`}
          >
            {toast.msg}
            {toast.sig && (
              <>
                {" · "}
                <a className="underline hover:text-fg" href={explorerTx(toast.sig)} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
