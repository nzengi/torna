"use client";

// Trade terminal: a market header (live best bid/ask/spread), the acting account (a connected WALLET
// or a pre-funded DEMO identity) with its live balances + a faucet, the order book, the trade form,
// and a cancellable open-orders list. All reads come off-chain via the SDK; nothing is mocked.
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Droplets, Wallet } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ASK, BID, type Side } from "@/lib/orderbook";
import { cancel, keypairActor, walletActor, requestFaucet, type Actor } from "@/lib/actions";
import { useBook } from "@/lib/useBook";
import { connection, demoKeypair, explorerTx, MARKET, reader, shorten } from "@/lib/market";
import { OrderBook } from "./OrderBook";
import { Trade } from "./Trade";
import { RecentTrades } from "./RecentTrades";

const amount = (d: Uint8Array | null) =>
  d && d.length >= 72 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true) : 0n;

// neon-friendly avatar hues, distinct from bid-green / ask-pink so they never read as a side
const TRADER_COLORS = ["#0088ff", "#9b5cff", "#00d0b0", "#ffb020"];

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
  const [bal, setBal] = useState<{ base: bigint; quote: bigint; sol: number } | null>(null);
  const [balKey, setBalKey] = useState(0);

  const useWalletAct = mode === "wallet" && connected;
  let actor: Actor | null = null;
  try {
    if (useWalletAct) actor = walletActor(wallet.publicKey!, wallet.sendTransaction);
    else if (mode === "demo" && MARKET.demos[idIdx]?.secret) actor = keypairActor(demoKeypair(idIdx));
  } catch {
    actor = null; // malformed demo identity in market.json -> no actor, page still renders
  }
  const me = actor?.publicKey.toBase58();

  // live balances of the acting account (base, quote, SOL)
  useEffect(() => {
    if (!me) { setBal(null); return; }
    let alive = true;
    (async () => {
      const c = connection();
      const r = reader(c);
      const pk = new PublicKey(me);
      const baseAta = getAssociatedTokenAddressSync(new PublicKey(MARKET.baseMint), pk, true);
      const quoteAta = getAssociatedTokenAddressSync(new PublicKey(MARKET.quoteMint), pk, true);
      const [bd, qd, sol] = await Promise.all([r.accountData(baseAta), r.accountData(quoteAta), c.getBalance(pk)]);
      if (alive) setBal({ base: amount(bd), quote: amount(qd), sol: sol / 1e9 });
    })().catch(() => { if (alive) setBal(null); });
    return () => { alive = false; };
  }, [me, balKey]);

  const refreshAll = () => { book.refresh(); setBalKey((k) => k + 1); };

  const mine = useMemo(() => {
    if (!me) return [];
    const a = book.asks.filter((o) => o.maker === me).map((o) => ({ ...o, side: ASK as Side }));
    const b = book.bids.filter((o) => o.maker === me).map((o) => ({ ...o, side: BID as Side }));
    return [...a, ...b];
  }, [book.asks, book.bids, me]);

  const bestAsk = book.asks[0]?.price;
  const bestBid = book.bids[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;
  const mid = bestAsk !== undefined && bestBid !== undefined ? (bestAsk + bestBid) / 2n : undefined;

  const doCancel = async (side: Side, keyHex: string) => {
    if (!actor || cancelling) return;
    setCancelling(keyHex);
    setMsg({ text: "cancelling order" });
    try {
      const sig = await cancel(actor, side, keyHex);
      setMsg({ text: "order cancelled", sig });
      refreshAll();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    } finally {
      setCancelling(null);
    }
  };

  const doFaucet = async () => {
    if (!wallet.publicKey || faucetBusy) return;
    setFaucetBusy(true);
    setMsg({ text: "requesting demo tokens" });
    try {
      const r = await requestFaucet(wallet.publicKey);
      setMsg(r.sig ? { text: "received demo tokens + SOL", sig: r.sig } : { text: "wallet already funded" });
      refreshAll();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    } finally {
      setFaucetBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* market header */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-line bg-panel px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tracking-tight">BASE / QUOTE</span>
          <span className="rounded bg-panel-hi px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-faint">devnet</span>
        </div>
        <Quote label="Best bid" value={bestBid} cls="text-bid" />
        <Quote label="Mid" value={mid} cls="text-fg" />
        <Quote label="Best ask" value={bestAsk} cls="text-ask" />
        <Quote label="Spread" value={spread} cls="text-muted" />
        <a href="/explorer" className="ml-auto text-xs text-brand hover:text-brand-hi">market accounts in Explorer</a>
      </div>

      {/* wallet + faucet, always visible so the jury can connect and fund right away */}
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">Your wallet <span className="font-normal text-faint">(optional)</span></div>
            <p className="mt-0.5 text-xs text-muted">Connect a devnet wallet to trade as yourself and fund it from the faucet, or just use a pre-funded demo trader below. No wallet needed to try it.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {connected ? (
              <span className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm">
                <span className="h-2 w-2 rounded-full bg-bid" aria-hidden />
                <span className="nums text-fg">{shorten(wallet.publicKey!.toBase58())}</span>
              </span>
            ) : (
              <button onClick={() => modal.setVisible(true)} className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
                <Wallet className="h-4 w-4" aria-hidden /> Connect wallet
              </button>
            )}
            <button onClick={doFaucet} disabled={!connected || faucetBusy} title={!connected ? "Connect a wallet first" : "Mint demo base, quote, and SOL to your wallet"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2 text-sm font-medium text-brand transition-colors duration-100 hover:bg-brand/10 active:translate-y-px disabled:pointer-events-none disabled:opacity-40">
              <Droplets className="h-4 w-4" aria-hidden /> {faucetBusy ? "Sending demo tokens" : "Get demo tokens"}
            </button>
          </div>
        </div>
        {msg && (
          <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
            {msg.text}
            {msg.sig && <> · <a className="text-brand underline hover:text-brand-hi" href={explorerTx(msg.sig)} target="_blank" rel="noreferrer">view transaction</a></>}
          </p>
        )}
      </div>

      {/* trade as (acting identity) + balances */}
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Trade as</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {MARKET.demos.map((d, i) => (
                <button
                  key={d.pubkey}
                  onClick={() => { setMode("demo"); setIdIdx(i); }}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors duration-100 active:translate-y-px ${mode === "demo" && i === idIdx ? "border-brand bg-brand/5" : "border-line hover:border-muted"}`}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: TRADER_COLORS[i % 4] }}>{i + 1}</span>
                  <span className="text-left leading-tight">
                    <span className="block text-sm font-medium text-fg">Trader {i + 1}</span>
                    <span className="nums block text-[11px] text-faint">{shorten(d.pubkey)}</span>
                  </span>
                </button>
              ))}
              <button
                onClick={() => { if (connected) setMode("wallet"); else modal.setVisible(true); }}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors duration-100 active:translate-y-px ${useWalletAct ? "border-brand bg-brand/5" : "border-line hover:border-muted"}`}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand/15"><Wallet className="h-3.5 w-3.5 text-brand" aria-hidden /></span>
                <span className="text-left leading-tight">
                  <span className="block text-sm font-medium text-fg">Your wallet</span>
                  <span className="nums block text-[11px] text-faint">{connected ? shorten(wallet.publicKey!.toBase58()) : "tap to connect"}</span>
                </span>
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Balances {useWalletAct ? "(your wallet)" : `(Trader ${idIdx + 1})`}</div>
            <div className="flex gap-2">
              <BalCard label="Base" value={bal ? bal.base.toLocaleString() : "-"} />
              <BalCard label="Quote" value={bal ? bal.quote.toLocaleString() : "-"} />
              <BalCard label="SOL" value={bal ? bal.sol.toFixed(3) : "-"} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <OrderBook asks={book.asks} bids={book.bids} loading={book.loading} error={book.error} mine={me} onRetry={book.refresh} />
        <Trade actor={actor} book={{ asks: book.asks, bids: book.bids }} onDone={refreshAll} />
        <div className="rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Your open orders</div>
          {!actor && <div className="px-4 py-6 text-center text-sm text-faint">pick an account to trade</div>}
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
                {cancelling === o.keyHex ? "..." : "cancel"}
              </button>
            </div>
          ))}
        </div>
      </div>

      <RecentTrades />
    </div>
  );
}

function Quote({ label, value, cls }: { label: string; value: bigint | undefined; cls: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={`nums text-sm font-semibold ${cls}`}>{value !== undefined ? value.toString() : "-"}</div>
    </div>
  );
}

function BalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[5.5rem] rounded-lg border border-line bg-bg-soft px-3 py-2 text-center">
      <div className="nums text-base font-semibold text-fg">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
    </div>
  );
}
