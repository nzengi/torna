"use client";

// Torna block explorer: an account-centric view (Solana-Explorer style) of the live market on
// devnet. Reads the real ask/bid B+ trees, the market accounts, and the escrow vault balances;
// nothing is mocked. Header stats, a leaf-account table per side, and an orders table per side.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownUp, Boxes, RefreshCw, Search } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { keys, type Tree, type Header, type AccountReader } from "torna-sdk";
import { askTree, bidTree, connection, reader, MARKET, explorerAddr } from "@/lib/market";
import { Address } from "./ui/Address";

const NODE_HDR = 44, N_KEY_COUNT = 2, N_NEXT_LEAF = 20, KEY = 32;

interface Order { price: bigint; size: bigint; maker: string; keyHex: string; leaf: bigint; }
interface Leaf { idx: bigint; pk: string; next: bigint; count: number; }
interface SideView { header: Header; leaves: Leaf[]; orders: Order[]; }
interface Overview {
  baseVault: bigint; quoteVault: bigint; baseDec: number; quoteDec: number;
}

const u64le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const u64be = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, false);
const u16le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);

async function readSide(r: AccountReader, tree: Tree, side: typeof keys.Side.Ask | typeof keys.Side.Bid): Promise<SideView | null> {
  const header = await tree.header(r);
  if (!header) return null;
  const voff = NODE_HDR + (header.fanout + 1) * KEY;
  const leaves: Leaf[] = [];
  const orders: Order[] = [];
  let idx = header.leftmost;
  let guard = 0;
  while (idx !== 0n && guard++ < 64) {
    const pk = tree.nodePda(idx)[0];
    const d = await r.accountData(pk);
    if (!d) break;
    const cnt = u16le(d, N_KEY_COUNT);
    let live = 0;
    for (let i = 0; i < cnt; i++) {
      const keyBytes = d.subarray(NODE_HDR + i * KEY, NODE_HDR + i * KEY + KEY);
      const size = u64be(d, voff + i * header.valueSize + 32);
      if (size === 0n) continue; // sentinel
      live++;
      orders.push({
        price: keys.priceOf(side, keyBytes),
        size,
        maker: new PublicKey(d.subarray(voff + i * header.valueSize, voff + i * header.valueSize + 32)).toBase58(),
        keyHex: Buffer.from(keyBytes).toString("hex"),
        leaf: idx,
      });
    }
    leaves.push({ idx, pk: pk.toBase58(), next: u64le(d, N_NEXT_LEAF), count: live });
    idx = u64le(d, N_NEXT_LEAF);
  }
  return { header, leaves, orders };
}

async function tokenAmount(r: AccountReader, addr: string): Promise<bigint> {
  const d = await r.accountData(new PublicKey(addr));
  return d && d.length >= 72 ? u64le(d, 64) : 0n; // SPL token account amount @64
}
async function mintDecimals(r: AccountReader, addr: string): Promise<number> {
  const d = await r.accountData(new PublicKey(addr));
  return d && d.length >= 45 ? d[44] : 0; // SPL mint decimals @44
}

// ---- presentational ----
function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="nums mt-1 text-xl font-semibold text-fg">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

function AccountsTable({ ov }: { ov: Overview | null }) {
  const rows: { role: string; addr: string; info: string }[] = [
    { role: "Market config (cfg)", addr: MARKET.cfg, info: "bound mints + vaults + book" },
    { role: "Book authority (PDA)", addr: MARKET.book, info: "sole writer of both trees" },
    { role: "Ask tree header", addr: askTree().headerPda()[0].toBase58(), info: "ascending price" },
    { role: "Bid tree header", addr: bidTree().headerPda()[0].toBase58(), info: "descending price" },
    { role: "Base mint", addr: MARKET.baseMint, info: ov ? `${ov.baseDec} decimals` : "" },
    { role: "Quote mint", addr: MARKET.quoteMint, info: ov ? `${ov.quoteDec} decimals` : "" },
    { role: "Base vault (escrow)", addr: MARKET.baseVault, info: ov ? `${ov.baseVault} base locked` : "" },
    { role: "Quote vault (escrow)", addr: MARKET.quoteVault, info: ov ? `${ov.quoteVault} quote locked` : "" },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="border-b border-line bg-panel-hi px-4 py-2.5 text-sm font-semibold">Market accounts</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.role} className={i % 2 ? "bg-bg-soft" : "bg-panel"}>
              <td className="px-4 py-2.5 font-medium text-fg">{r.role}</td>
              <td className="px-4 py-2.5 text-muted">{r.info}</td>
              <td className="px-4 py-2.5 text-right"><Address value={r.addr} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeaderStats({ h }: { h: Header }) {
  const cells: [string, string][] = [
    ["height", String(h.height)],
    ["fanout", String(h.fanout)],
    ["root node", `#${h.root}`],
    ["leftmost", `#${h.leftmost}`],
    ["rightmost", `#${h.rightmost}`],
    ["value size", `${h.valueSize}B`],
    ["node size", `${h.nodeSize}B`],
    ["structure epoch", String(h.structureEpoch)],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
      {cells.map(([k, v]) => (
        <div key={k}>
          <div className="text-[11px] uppercase tracking-wide text-faint">{k}</div>
          <div className="nums text-sm text-fg">{v}</div>
        </div>
      ))}
    </div>
  );
}

function LeafTable({ leaves }: { leaves: Leaf[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="border-b border-line bg-panel-hi px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Leaf accounts (leftmost to rightmost)
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-faint">
            <th className="px-4 py-2 text-left font-medium">node</th>
            <th className="px-4 py-2 text-left font-medium">account</th>
            <th className="px-4 py-2 text-right font-medium">orders</th>
            <th className="px-4 py-2 text-right font-medium">next leaf</th>
          </tr>
        </thead>
        <tbody>
          {leaves.map((l, i) => (
            <tr key={l.pk} className={i % 2 ? "bg-bg-soft" : "bg-panel"}>
              <td className="nums px-4 py-2 text-fg">#{l.idx.toString()}</td>
              <td className="px-4 py-2"><Address value={l.pk} /></td>
              <td className="nums px-4 py-2 text-right text-fg">{l.count}</td>
              <td className="nums px-4 py-2 text-right text-faint">{l.next === 0n ? "none" : `#${l.next}`}</td>
            </tr>
          ))}
          {leaves.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-faint">no leaves</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function OrdersTable({ orders, side }: { orders: Order[]; side: "ask" | "bid" }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="border-b border-line bg-panel-hi px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Resting orders ({orders.length})
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-faint">
            <th className="px-4 py-2 text-left font-medium">price</th>
            <th className="px-4 py-2 text-right font-medium">size</th>
            <th className="px-4 py-2 text-left font-medium">maker</th>
            <th className="px-4 py-2 text-right font-medium">leaf</th>
            <th className="px-4 py-2 text-right font-medium">order key</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.keyHex} className="border-t border-line/50">
              <td className={`nums px-4 py-2 ${side === "ask" ? "text-ask" : "text-bid"}`}>{o.price.toString()}</td>
              <td className="nums px-4 py-2 text-right text-fg">{o.size.toString()}</td>
              <td className="px-4 py-2"><Address value={o.maker} /></td>
              <td className="nums px-4 py-2 text-right text-faint">#{o.leaf.toString()}</td>
              <td className="nums px-4 py-2 text-right text-faint" title={o.keyHex}>{o.keyHex.slice(0, 8)}…{o.keyHex.slice(-4)}</td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-faint">no resting orders</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function Explorer() {
  const [ask, setAsk] = useState<SideView | null>(null);
  const [bid, setBid] = useState<SideView | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [tab, setTab] = useState<"ask" | "bid">("ask");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = reader(connection());
      const [a, b, bv, qv, bd, qd] = await Promise.all([
        readSide(r, askTree(), keys.Side.Ask),
        readSide(r, bidTree(), keys.Side.Bid),
        tokenAmount(r, MARKET.baseVault),
        tokenAmount(r, MARKET.quoteVault),
        mintDecimals(r, MARKET.baseMint),
        mintDecimals(r, MARKET.quoteMint),
      ]);
      setAsk(a); setBid(b);
      setOv({ baseVault: bv, quoteVault: qv, baseDec: bd, quoteDec: qd });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 8000);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const side = tab === "ask" ? ask : bid;
  const bestAsk = ask?.orders[0]?.price;
  const bestBid = bid?.orders[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;
  const totalOrders = (ask?.orders.length ?? 0) + (bid?.orders.length ?? 0);
  const totalLeaves = (ask?.leaves.length ?? 0) + (bid?.leaves.length ?? 0);

  // search filters the visible orders by price, maker prefix, or order-key hex
  const filtered = useMemo(() => {
    if (!side) return [];
    const t = q.trim().toLowerCase();
    if (!t) return side.orders;
    return side.orders.filter((o) =>
      o.price.toString().includes(t) || o.maker.toLowerCase().includes(t) || o.keyHex.includes(t));
  }, [side, q]);
  const pasted = (() => { try { return q.trim().length >= 32 ? new PublicKey(q.trim()).toBase58() : null; } catch { return null; } })();

  return (
    <div className="space-y-5">
      {/* search + status */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter orders by price / maker / key, or paste an address"
            className="w-full rounded-lg border border-line bg-panel py-2 pl-9 pr-3 text-sm outline-none transition-colors duration-100 focus:border-brand"
          />
        </div>
        <span className="flex items-center gap-1.5 text-xs text-faint">
          {loading && <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />} {loading ? "reading on-chain" : "live, every 8s"}
        </span>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-muted transition-colors duration-100 hover:border-muted hover:text-fg active:translate-y-px">
          <RefreshCw className="h-3 w-3" aria-hidden /> Refresh
        </button>
      </div>
      {pasted && (
        <a href={explorerAddr(pasted)} target="_blank" rel="noreferrer" className="block rounded-lg border border-brand/40 bg-brand/5 px-4 py-2 text-sm text-brand">
          Open {pasted.slice(0, 8)}… on Solana Explorer (devnet)
        </a>
      )}
      {error && <div className="rounded-lg border border-ask/40 bg-ask/5 px-4 py-3 text-sm text-ask">RPC error: {error}</div>}

      {/* overview metrics */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Best bid / ask" value={`${bestBid?.toString() ?? "-"} / ${bestAsk?.toString() ?? "-"}`} sub={spread !== undefined ? `spread ${spread}` : ""} />
        <Metric label="Resting orders" value={totalOrders} sub={`${ask?.orders.length ?? 0} ask, ${bid?.orders.length ?? 0} bid`} />
        <Metric label="Base escrowed" value={ov ? ov.baseVault.toString() : "-"} sub="locked in the base vault" />
        <Metric label="Quote escrowed" value={ov ? ov.quoteVault.toString() : "-"} sub="locked in the quote vault" />
      </div>

      <AccountsTable ov={ov} />

      {/* per-side tree explorer */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <div className="flex rounded-lg border border-line p-0.5 text-sm">
            <button onClick={() => setTab("ask")} className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors duration-100 ${tab === "ask" ? "bg-panel-hi font-medium text-ask" : "text-muted hover:text-fg"}`}>
              <ArrowDownUp className="h-3.5 w-3.5" aria-hidden /> Ask tree
            </button>
            <button onClick={() => setTab("bid")} className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors duration-100 ${tab === "bid" ? "bg-panel-hi font-medium text-bid" : "text-muted hover:text-fg"}`}>
              <Boxes className="h-3.5 w-3.5" aria-hidden /> Bid tree
            </button>
          </div>
          <span className="text-xs text-faint">{tab === "ask" ? "ascending price" : "descending price"}</span>
        </div>

        {side ? (
          <div className="space-y-3">
            <HeaderStats h={side.header} />
            <LeafTable leaves={side.leaves} />
            <OrdersTable orders={filtered} side={tab} />
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-panel p-6 text-center text-sm text-faint">tree not found</div>
        )}
      </div>
    </div>
  );
}
