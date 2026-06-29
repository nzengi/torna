"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ASK, BID, type Side } from "@/lib/orderbook";
import { place, take, type Actor } from "@/lib/actions";
import { explorerTx } from "@/lib/market";

type Toast = { kind: "pending" | "ok" | "err"; msg: string; sig?: string } | null;

export function Trade({ actor, onDone }: { actor: Actor | null; onDone: () => void }) {
  const [tab, setTab] = useState<"place" | "take">("place");
  const [side, setSide] = useState<Side>(ASK);
  const [price, setPrice] = useState("103");
  const [size, setSize] = useState("3");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const run = async (fn: () => Promise<string | null>, label: string) => {
    if (!actor) { setToast({ kind: "err", msg: "connect a wallet or pick a demo identity" }); return; }
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

  const doPlace = () => run(() => place(actor!, side, BigInt(price), BigInt(size)), `place ${side === ASK ? "ask" : "bid"} ${size}@${price}`);
  const doTake = () => run(async () => {
    const r = await take(actor!, side, BigInt(price), BigInt(size));
    return r ? r.sig : null;
  }, `${side === ASK ? "buy" : "sell"} ${size} @ limit ${price}`);

  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="flex border-b border-line text-sm">
        {(["place", "take"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2.5 transition-colors duration-100 ${tab === t ? "border-b-2 border-brand font-medium text-fg" : "text-faint hover:text-muted"}`}>
            {t === "place" ? "Place (maker)" : "Take (taker)"}
          </button>
        ))}
      </div>

      <div className="space-y-3 px-4 py-4">
        <div className="flex gap-2">
          <button onClick={() => setSide(ASK)} className={`flex-1 rounded-lg border py-2 text-sm transition-colors duration-100 active:translate-y-px ${side === ASK ? "border-ask text-ask" : "border-line text-muted hover:border-muted"}`}>
            {tab === "place" ? "Sell (ask)" : "Buy (hit asks)"}
          </button>
          <button onClick={() => setSide(BID)} className={`flex-1 rounded-lg border py-2 text-sm transition-colors duration-100 active:translate-y-px ${side === BID ? "border-bid text-bid" : "border-line text-muted hover:border-muted"}`}>
            {tab === "place" ? "Buy (bid)" : "Sell (hit bids)"}
          </button>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-faint">{tab === "place" ? "price" : "limit price"}</span>
          <input value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))} inputMode="numeric"
            className="nums mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors duration-100 focus:border-brand" />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-faint">size</span>
          <input value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, ""))} inputMode="numeric"
            className="nums mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors duration-100 focus:border-brand" />
        </label>

        <button
          disabled={busy || !price || !size || !actor}
          aria-busy={busy}
          onClick={tab === "place" ? doPlace : doTake}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy ? "Submitting" : !actor ? "Pick an account" : tab === "place" ? "Place order" : "Take"}
        </button>

        {toast && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${toast.kind === "ok" ? "border-bid/40 text-bid" : toast.kind === "err" ? "border-ask/40 text-ask" : "border-line text-muted"}`}>
            {toast.msg}
            {toast.sig && <> · <a className="underline hover:text-fg" href={explorerTx(toast.sig)} target="_blank" rel="noreferrer">tx ↗</a></>}
          </div>
        )}
      </div>
    </div>
  );
}
