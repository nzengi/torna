"use client";

// Live on-chain inspector: reads the actual ask/bid trees from devnet and renders their real
// structure -- header stats + the leftmost->next_leaf chain of leaf accounts, each with the orders
// it holds. This is the on-chain B+ tree, visualized; nothing is mocked.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { keys, type Tree, type Header, type AccountReader } from "torna-sdk";
import { askTree, bidTree, connection, reader, shorten, explorerAddr } from "@/lib/market";

const NODE_HDR = 44, N_KEY_COUNT = 2, N_NEXT_LEAF = 20, N_NODE_IDX = 12, KEY = 32;

interface LeafView { idx: bigint; pk: string; next: bigint; orders: { price: bigint; size: bigint; maker: string }[]; }
interface SideView { header: Header; leaves: LeafView[]; }

async function readSide(r: AccountReader, tree: Tree, side: typeof keys.Side.Ask | typeof keys.Side.Bid): Promise<SideView | null> {
  const header = await tree.header(r);
  if (!header) return null;
  const voff = NODE_HDR + (header.fanout + 1) * KEY;
  const leaves: LeafView[] = [];
  let idx = header.leftmost;
  let guard = 0;
  while (idx !== 0n && guard++ < 64) {
    const pk = tree.nodePda(idx)[0];
    const d = await r.accountData(pk);
    if (!d) break;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const cnt = dv.getUint16(N_KEY_COUNT, true);
    const orders: LeafView["orders"] = [];
    for (let i = 0; i < cnt; i++) {
      const key = d.subarray(NODE_HDR + i * KEY, NODE_HDR + i * KEY + KEY);
      const size = dv.getBigUint64(voff + i * header.valueSize + 32, false);
      if (size === 0n) continue; // sentinel
      const maker = new PublicKey(d.subarray(voff + i * header.valueSize, voff + i * header.valueSize + 32)).toBase58();
      orders.push({ price: keys.priceOf(side, key), size, maker });
    }
    leaves.push({ idx, pk: pk.toBase58(), next: dv.getBigUint64(N_NEXT_LEAF, true), orders });
    idx = dv.getBigUint64(N_NEXT_LEAF, true);
  }
  return { header, leaves };
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted">{k}</span>
      <span className="nums text-fg">{v}</span>
    </div>
  );
}

function SidePanel({ title, view }: { title: string; view: SideView | null }) {
  if (!view) return <div className="rounded-xl border border-line bg-panel p-5 text-sm text-faint">{title}: not found</div>;
  const h = view.header;
  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">{title}</div>
      <div className="grid gap-x-6 px-4 py-2 sm:grid-cols-2">
        <Stat k="height" v={String(h.height)} />
        <Stat k="fanout" v={String(h.fanout)} />
        <Stat k="root node" v={`#${h.root}`} />
        <Stat k="leftmost leaf" v={`#${h.leftmost}`} />
        <Stat k="value size" v={`${h.valueSize}B`} />
        <Stat k="structure epoch" v={String(h.structureEpoch)} />
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-faint">leaf chain (leftmost → next)</div>
        <div className="flex flex-wrap items-stretch gap-2">
          {view.leaves.map((leaf, i) => (
            <div key={leaf.pk} className="flex items-center gap-2">
              <a href={explorerAddr(leaf.pk)} target="_blank" rel="noreferrer" className="block min-w-32 rounded-lg border border-line bg-bg-soft p-2.5 transition-colors duration-100 hover:border-brand">
                <div className="nums mb-1 text-[11px] text-faint">leaf #{leaf.idx.toString()}</div>
                {leaf.orders.length === 0 && <div className="text-xs text-faint">empty</div>}
                {leaf.orders.map((o, j) => (
                  <div key={j} className="nums flex justify-between gap-3 text-xs">
                    <span className="text-fg">{o.size.toString()}@{o.price.toString()}</span>
                    <span className="text-faint">{o.maker.slice(0, 4)}</span>
                  </div>
                ))}
              </a>
              {i < view.leaves.length - 1 && <span className="text-faint">→</span>}
            </div>
          ))}
          {view.leaves.length === 0 && <span className="text-sm text-faint">no leaves</span>}
        </div>
      </div>
    </div>
  );
}

export function Explorer() {
  const [ask, setAsk] = useState<SideView | null>(null);
  const [bid, setBid] = useState<SideView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = reader(connection());
      const [a, b] = await Promise.all([readSide(r, askTree(), keys.Side.Ask), readSide(r, bidTree(), keys.Side.Bid)]);
      setAsk(a); setBid(b); setError(null);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-faint">
          {loading && <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />} {loading ? "reading on-chain state" : "live · refreshes every 8s"}
        </span>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded border border-line bg-panel px-2.5 py-1 text-xs text-muted transition-colors duration-100 hover:border-muted hover:text-fg active:translate-y-px">
          <RefreshCw className="h-3 w-3" aria-hidden /> Refresh
        </button>
      </div>
      {error && <div className="rounded-lg border border-ask/40 bg-ask/5 px-4 py-3 text-sm text-ask">RPC error: {error}</div>}
      <SidePanel title="Ask book (ascending price)" view={ask} />
      <SidePanel title="Bid book (descending price)" view={bid} />
    </div>
  );
}
