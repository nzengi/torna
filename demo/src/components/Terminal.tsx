"use client";

// Act 1 client shell: owns the live book poll, the acting account (a connected WALLET or a pre-funded
// DEMO identity), and wires the book, trade form, and cancellable "your orders" together.
import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Droplets, Wallet } from "lucide-react";
import { ASK, BID, type Side } from "@/lib/orderbook";
import { cancel, keypairActor, walletActor, requestFaucet, type Actor } from "@/lib/actions";
import { useBook } from "@/lib/useBook";
import { demoKeypair, explorerTx, MARKET, shorten } from "@/lib/market";
import { OrderBook } from "./OrderBook";
import { Trade } from "./Trade";

export function Terminal() {
  const book = useBook();
  const wallet = useWallet();
  const modal = useWalletModal();
  const connected = wallet.connected && !!wallet.publicKey;
  const [mode, setMode] = useState<"wallet" | "demo">("demo");
  const [idIdx, setIdIdx] = useState(0);
  const [msg, setMsg] = useState<{ text: string; sig?: string } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);

  const useWalletAct = mode === "wallet" && connected;
  let actor: Actor | null = null;
  try {
    if (useWalletAct) actor = walletActor(wallet.publicKey!, wallet.sendTransaction);
    else if (mode === "demo" && MARKET.demos[idIdx]?.secret) actor = keypairActor(demoKeypair(idIdx));
  } catch {
    actor = null; // malformed demo identity in market.json -> no actor, page still renders
  }
  const me = actor?.publicKey.toBase58();

  const mine = useMemo(() => {
    if (!me) return [];
    const a = book.asks.filter((o) => o.maker === me).map((o) => ({ ...o, side: ASK as Side }));
    const b = book.bids.filter((o) => o.maker === me).map((o) => ({ ...o, side: BID as Side }));
    return [...a, ...b];
  }, [book.asks, book.bids, me]);

  const doCancel = async (side: Side, keyHex: string) => {
    if (!actor || cancelling) return;
    setCancelling(keyHex);
    setMsg({ text: "cancelling…" });
    try {
      const sig = await cancel(actor, side, keyHex);
      setMsg({ text: "cancelled", sig });
      book.refresh();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    } finally {
      setCancelling(null);
    }
  };

  const doFaucet = async () => {
    if (!wallet.publicKey || faucetBusy) return;
    setFaucetBusy(true);
    setMsg({ text: "requesting demo tokens…" });
    try {
      const r = await requestFaucet(wallet.publicKey);
      setMsg(r.sig ? { text: "received demo tokens + SOL", sig: r.sig } : { text: "wallet already funded" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    } finally {
      setFaucetBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* account bar */}
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-line p-0.5 text-sm">
            {(["wallet", "demo"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 transition-colors duration-100 ${mode === m ? "bg-panel-hi font-medium text-fg" : "text-muted hover:text-fg"}`}
              >
                {m === "wallet" ? "My wallet" : "Demo identity"}
              </button>
            ))}
          </div>

          {mode === "wallet" ? (
            connected ? (
              <>
                <span className="nums flex items-center gap-1.5 text-sm text-fg">
                  <Wallet className="h-4 w-4 text-brand" aria-hidden /> {shorten(wallet.publicKey!.toBase58())}
                </span>
                <button onClick={doFaucet} disabled={faucetBusy} className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand/5 px-3 py-1.5 text-sm text-brand transition-colors duration-100 hover:bg-brand/10 active:translate-y-px disabled:pointer-events-none disabled:opacity-50">
                  <Droplets className="h-4 w-4" aria-hidden /> {faucetBusy ? "Requesting…" : "Get demo tokens"}
                </button>
              </>
            ) : (
              <button onClick={() => modal.setVisible(true)} className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
                <Wallet className="h-4 w-4" aria-hidden /> Connect wallet
              </button>
            )
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {MARKET.demos.map((d, i) => (
                <button
                  key={d.pubkey}
                  onClick={() => setIdIdx(i)}
                  className={`nums rounded border px-2.5 py-1 text-xs transition-colors duration-100 active:translate-y-px ${i === idIdx ? "border-brand text-brand" : "border-line text-muted hover:border-muted"}`}
                >
                  demo{i} {shorten(d.pubkey)}
                </button>
              ))}
            </div>
          )}
        </div>
        {mode === "wallet" && (
          <p className="mt-2 text-xs text-faint">
            Connect Phantom/Solflare on devnet, grab demo tokens from the faucet, then trade with your own wallet.
          </p>
        )}
        {msg && (
          <p className="mt-2 text-xs text-muted">
            {msg.text}
            {msg.sig && <> · <a className="text-brand underline hover:text-brand-hi" href={explorerTx(msg.sig)} target="_blank" rel="noreferrer">tx ↗</a></>}
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <OrderBook asks={book.asks} bids={book.bids} loading={book.loading} error={book.error} mine={me} onRetry={book.refresh} />
        <Trade actor={actor} onDone={book.refresh} />
        <div className="rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Your open orders</div>
          {!actor && <div className="px-4 py-6 text-center text-sm text-faint">connect a wallet to trade</div>}
          {actor && mine.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">no open orders</div>}
          {mine.map((o) => (
            <div key={o.keyHex} className="flex items-center justify-between border-b border-line/60 px-4 py-2 text-sm last:border-0">
              <span className={`nums ${o.side === ASK ? "text-ask" : "text-bid"}`}>
                {o.side === ASK ? "ASK" : "BID"} {o.size.toString()}@{o.price.toString()}
              </span>
              <button
                onClick={() => doCancel(o.side, o.keyHex)}
                disabled={cancelling !== null}
                className="rounded border border-line px-3 py-1 text-xs text-muted transition-colors duration-100 hover:border-ask hover:text-ask active:translate-y-px disabled:pointer-events-none disabled:opacity-50"
              >
                {cancelling === o.keyHex ? "…" : "cancel"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
