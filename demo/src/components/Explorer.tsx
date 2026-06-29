"use client";

// Torna block explorer: an account-centric, Torna-aware view of the live market on devnet. Reads the
// real ask/bid B+ trees, the market accounts, and the escrow vaults; decodes any pasted account
// (Torna header / node / SPL token) into its on-chain fields; and shows a live transaction feed for
// the orderbook program. Nothing is mocked.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownUp, Boxes, ExternalLink, RefreshCw, Search } from "lucide-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { keys, type Tree, type Header, type AccountReader } from "torna-sdk";
import { askTree, bidTree, connection, reader, MARKET, explorerAddr, explorerTx, shorten } from "@/lib/market";
import { Address } from "./ui/Address";

const NODE_HDR = 44, N_KEY_COUNT = 2, N_NEXT_LEAF = 20, KEY = 32;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TORNA_MAGIC = 0x3454_4254; // "TBT4" as u32 LE

const u64le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const u64be = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, false);
const u32le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
const u16le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
const hex = (d: Uint8Array) => Buffer.from(d).toString("hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return new Uint8Array();
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

interface Order { price: bigint; size: bigint; maker: string; keyHex: string; leaf: bigint; slot: bigint; }
interface Leaf { idx: bigint; pk: string; next: bigint; count: number; }
interface SideView { header: Header; leaves: Leaf[]; orders: Order[]; }
interface Overview { baseVault: bigint; quoteVault: bigint; baseDec: number; quoteDec: number; }

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
      if (size === 0n) continue;
      live++;
      orders.push({
        price: keys.priceOf(side, keyBytes), size,
        maker: new PublicKey(d.subarray(voff + i * header.valueSize, voff + i * header.valueSize + 32)).toBase58(),
        keyHex: hex(keyBytes), slot: u64be(keyBytes, 8), leaf: idx,
      });
    }
    leaves.push({ idx, pk: pk.toBase58(), next: u64le(d, N_NEXT_LEAF), count: live });
    idx = u64le(d, N_NEXT_LEAF);
  }
  return { header, leaves, orders };
}
async function tokenAmount(r: AccountReader, addr: string): Promise<bigint> {
  const d = await r.accountData(new PublicKey(addr));
  return d && d.length >= 72 ? u64le(d, 64) : 0n;
}
async function mintDecimals(r: AccountReader, addr: string): Promise<number> {
  const d = await r.accountData(new PublicKey(addr));
  return d && d.length >= 45 ? d[44] : 0;
}

// ---- account inspector: decode any pasted address as a Torna header/node or an SPL token account ----
interface Decoded { kind: string; fields: [string, string][]; }
async function inspect(conn: Connection, pk: PublicKey): Promise<Decoded | { kind: "none" }> {
  const info = await conn.getAccountInfo(pk, "confirmed");
  if (!info) return { kind: "none" };
  const d = Uint8Array.from(info.data);
  const owner = info.owner.toBase58();
  if (owner === TOKEN_PROGRAM && d.length >= 72) {
    return { kind: "SPL token account", fields: [
      ["mint", shorten(new PublicKey(d.subarray(0, 32)).toBase58())],
      ["owner", shorten(new PublicKey(d.subarray(32, 64)).toBase58())],
      ["amount", u64le(d, 64).toLocaleString()],
    ] };
  }
  if (owner === MARKET.tornaProgramId) {
    if (d.length >= 146 && u32le(d, 0) === TORNA_MAGIC) {
      return { kind: "Torna tree header", fields: [
        ["version", String(u16le(d, 4))], ["fanout", String(u16le(d, 48))], ["value size", `${u16le(d, 46)} B`],
        ["height", String(u32le(d, 62))], ["root node", `#${u64le(d, 54)}`], ["leftmost leaf", `#${u64le(d, 66)}`],
        ["structure epoch", String(u64le(d, 82))], ["tree_uid", hex(d.subarray(122, 138))],
      ] };
    }
    if (d.length >= NODE_HDR && d[1] === 1) {
      return { kind: d[0] === 1 ? "Torna leaf node" : "Torna internal node", fields: [
        ["is_leaf", d[0] === 1 ? "yes" : "no"], ["key_count", String(u16le(d, 2))],
        ["node_idx", `#${u64le(d, 12)}`], ["next_leaf", u64le(d, 20) === 0n ? "none" : `#${u64le(d, 20)}`],
        ["tree_uid", hex(d.subarray(28, 44))],
      ] };
    }
  }
  return { kind: "account", fields: [
    ["owner", shorten(owner)], ["size", `${d.length} B`], ["lamports", info.lamports.toLocaleString()],
  ] };
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
function FieldRows({ rows }: { rows: [string, string][] }) {
  return (
    <div className="divide-y divide-line/60">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between py-1.5 text-sm">
          <span className="text-muted">{k}</span><span className="nums text-fg">{v}</span>
        </div>
      ))}
    </div>
  );
}
function AccountsTable({ ov }: { ov: Overview | null }) {
  const rows: [string, string, string][] = [
    ["Market config (cfg)", MARKET.cfg, "bound mints + vaults + book"],
    ["Book authority (PDA)", MARKET.book, "sole writer of both trees"],
    ["Ask tree header", askTree().headerPda()[0].toBase58(), "ascending price"],
    ["Bid tree header", bidTree().headerPda()[0].toBase58(), "descending price"],
    ["Base mint", MARKET.baseMint, ov ? `${ov.baseDec} decimals` : ""],
    ["Quote mint", MARKET.quoteMint, ov ? `${ov.quoteDec} decimals` : ""],
    ["Base vault (escrow)", MARKET.baseVault, ov ? `${ov.baseVault} base locked` : ""],
    ["Quote vault (escrow)", MARKET.quoteVault, ov ? `${ov.quoteVault} quote locked` : ""],
  ];
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <div className="border-b border-line bg-panel-hi px-4 py-2.5 text-sm font-semibold">Market accounts</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[0]} className={i % 2 ? "bg-bg-soft" : "bg-panel"}>
              <td className="px-4 py-2.5 font-medium text-fg">{r[0]}</td>
              <td className="px-4 py-2.5 text-muted">{r[2]}</td>
              <td className="px-4 py-2.5 text-right"><Address value={r[1]} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function HeaderStats({ h }: { h: Header }) {
  const cells: [string, string][] = [
    ["height", String(h.height)], ["fanout", String(h.fanout)], ["root node", `#${h.root}`],
    ["leftmost", `#${h.leftmost}`], ["rightmost", `#${h.rightmost}`], ["value size", `${h.valueSize}B`],
    ["node size", `${h.nodeSize}B`], ["structure epoch", String(h.structureEpoch)],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-line bg-panel p-4 sm:grid-cols-4">
      {cells.map(([k, v]) => (
        <div key={k}><div className="text-[11px] uppercase tracking-wide text-faint">{k}</div><div className="nums text-sm text-fg">{v}</div></div>
      ))}
    </div>
  );
}
function LeafTable({ leaves }: { leaves: Leaf[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <div className="border-b border-line bg-panel-hi px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Leaf accounts (leftmost to rightmost)</div>
      <table className="w-full text-sm">
        <thead><tr className="text-[11px] uppercase tracking-wide text-faint">
          <th className="px-4 py-2 text-left font-medium">node</th><th className="px-4 py-2 text-left font-medium">account</th>
          <th className="px-4 py-2 text-right font-medium">orders</th><th className="px-4 py-2 text-right font-medium">next leaf</th>
        </tr></thead>
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
function Seg({ label, hex, value, color }: { label: string; hex: string; value: string; color: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-line bg-panel p-2.5" style={{ borderTopColor: color, borderTopWidth: 2 }}>
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className="nums truncate text-sm font-semibold text-fg" title={value}>{value}</div>
      <div className="nums mt-0.5 truncate text-[10px] text-faint" title={hex}>{hex}</div>
    </div>
  );
}
function OrderDetail({ o, side }: { o: Order; side: "ask" | "bid" }) {
  const nonce = BigInt("0x" + o.keyHex.slice(48, 64));
  const cBid = "var(--bid)", cAsk = "var(--ask)", cPar = "var(--parallel)", cBrand = "var(--brand)", cFaint = "var(--faint)";
  return (
    <div className="space-y-4 px-4 py-4">
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-faint">order key = price | slot | maker[0..8] | nonce (32 bytes, big-endian)</div>
        <div className="flex flex-wrap gap-2">
          <Seg label="price (8B)" hex={o.keyHex.slice(0, 16)} value={o.price.toString()} color={side === "ask" ? cAsk : cBid} />
          <Seg label="slot (8B)" hex={o.keyHex.slice(16, 32)} value={o.slot.toString()} color={cPar} />
          <Seg label="maker[0..8] (8B)" hex={o.keyHex.slice(32, 48)} value={o.keyHex.slice(32, 48)} color={cBrand} />
          <Seg label="nonce (8B)" hex={o.keyHex.slice(48, 64)} value={nonce.toString()} color={cFaint} />
        </div>
        {side === "bid" && <div className="mt-1.5 text-[11px] text-faint">bid price is stored inverted (u64 max minus price) so better bids sort first; the value shown is decoded.</div>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-3">
          <div className="text-[11px] uppercase tracking-wide text-faint">order value</div>
          <div className="mt-1.5 flex items-center justify-between text-sm"><span className="text-muted">maker (full 32B)</span><Address value={o.maker} /></div>
          <div className="mt-1 flex items-center justify-between text-sm"><span className="text-muted">size</span><span className="nums text-fg">{o.size.toString()}</span></div>
        </div>
        <div className="rounded-lg border border-line bg-panel p-3">
          <div className="text-[11px] uppercase tracking-wide text-faint">stored in</div>
          <div className="mt-1.5 flex items-center justify-between text-sm"><span className="text-muted">leaf node</span><span className="nums text-fg">#{o.leaf.toString()}</span></div>
          <div className="mt-1 flex items-center justify-between text-sm"><span className="text-muted">full key</span><span className="nums text-faint" title={o.keyHex}>{o.keyHex.slice(0, 10)}…</span></div>
        </div>
      </div>
    </div>
  );
}
function OrdersTable({ orders, side }: { orders: Order[]; side: "ask" | "bid" }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <div className="border-b border-line bg-panel-hi px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Resting orders ({orders.length}) · click a row for the key breakdown</div>
      <table className="w-full text-sm">
        <thead><tr className="text-[11px] uppercase tracking-wide text-faint">
          <th className="px-4 py-2 text-left font-medium">price</th><th className="px-4 py-2 text-right font-medium">size</th>
          <th className="px-4 py-2 text-left font-medium">maker</th><th className="px-4 py-2 text-right font-medium">slot</th>
          <th className="px-4 py-2 text-right font-medium">order key</th>
        </tr></thead>
        <tbody>
          {orders.map((o) => (
            <Fragment key={o.keyHex}>
              <tr tabIndex={0} role="button" aria-expanded={open === o.keyHex}
                onClick={() => setOpen(open === o.keyHex ? null : o.keyHex)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(open === o.keyHex ? null : o.keyHex); } }}
                className={`cursor-pointer border-t border-line/50 transition-colors duration-100 hover:bg-panel-hi focus-visible:bg-panel-hi ${open === o.keyHex ? "bg-panel-hi" : ""}`}>
                <td className={`nums px-4 py-2 ${side === "ask" ? "text-ask" : "text-bid"}`}>{o.price.toString()}</td>
                <td className="nums px-4 py-2 text-right text-fg">{o.size.toString()}</td>
                <td className="px-4 py-2"><Address value={o.maker} /></td>
                <td className="nums px-4 py-2 text-right text-faint">{o.slot.toString()}</td>
                <td className="nums px-4 py-2 text-right text-faint">{o.keyHex.slice(0, 8)}…{o.keyHex.slice(-4)}</td>
              </tr>
              {open === o.keyHex && <tr className="border-t border-line/50 bg-bg-soft"><td colSpan={5}><OrderDetail o={o} side={side} /></td></tr>}
            </Fragment>
          ))}
          {orders.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-faint">no resting orders</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// visual tree: header -> root -> the real leaf chain (read on-chain), each leaf with its order count
function TreeView({ header, leaves, side }: { header: Header; leaves: Leaf[]; side: "ask" | "bid" }) {
  const color = side === "ask" ? "var(--ask)" : "var(--bid)";
  const boxW = 120, gap = 30, n = Math.max(leaves.length, 1);
  const rowW = n * boxW + (n - 1) * gap;
  const W = Math.max(rowW + 40, 380);
  const cx = W / 2;
  const internal = header.height >= 2;
  const leafY = internal ? 158 : 96;
  const startX = (W - rowW) / 2;
  const leafCx = (i: number) => startX + i * (boxW + gap) + boxW / 2;
  return (
    <svg viewBox={`0 0 ${W} ${leafY + 72}`} className="w-full" role="img" aria-label={`${side} tree structure: header, root, and ${leaves.length} leaves`}>
      <rect x={cx - 95} y={10} width={190} height={46} rx={8} fill="var(--panel)" stroke="var(--brand)" strokeWidth={1.4} />
      <text x={cx} y={31} textAnchor="middle" fontSize="12.5" fontWeight="600" fill="var(--fg)">Tree header</text>
      <text x={cx} y={46} textAnchor="middle" fontSize="10" fill="var(--muted)">height {header.height} · fanout {header.fanout} · root #{header.root.toString()}</text>
      {internal ? (
        <>
          <line x1={cx} y1={56} x2={cx} y2={92} stroke="var(--line)" />
          <rect x={cx - 75} y={92} width={150} height={40} rx={8} fill="var(--panel)" stroke="var(--line)" />
          <text x={cx} y={116} textAnchor="middle" fontSize="11.5" fill="var(--fg)">root #{header.root.toString()} (internal)</text>
          {leaves.map((l, i) => <line key={`p${i}`} x1={cx} y1={132} x2={leafCx(i)} y2={leafY} stroke="var(--line)" />)}
        </>
      ) : (
        <line x1={cx} y1={56} x2={leafCx(0)} y2={leafY} stroke="var(--line)" />
      )}
      {leaves.map((l, i) => (
        <g key={l.idx.toString()}>
          {i > 0 && <line x1={leafCx(i - 1) + boxW / 2} y1={leafY + 26} x2={leafCx(i) - boxW / 2} y2={leafY + 26} stroke="var(--line)" strokeDasharray="4 3" />}
          <rect x={leafCx(i) - boxW / 2} y={leafY} width={boxW} height={52} rx={8} fill={`color-mix(in srgb, ${color} 8%, var(--panel))`} stroke={(!internal || header.root === l.idx) ? "var(--brand)" : color} strokeWidth={1.4} />
          <text x={leafCx(i)} y={leafY + 22} textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--fg)">leaf #{l.idx.toString()}</text>
          <text x={leafCx(i)} y={leafY + 38} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{l.count} orders</text>
        </g>
      ))}
      {leaves.length === 0 && <text x={cx} y={leafY + 26} textAnchor="middle" fontSize="12" fill="var(--faint)">empty tree</text>}
    </svg>
  );
}

interface Sig { signature: string; slot: number; err: boolean; blockTime: number | null; op: number; isBuy: boolean; price?: string; size?: string }
const OP_LABEL = ["place", "cancel", "match", "place", "init"];
const OPS = ["Place order", "Cancel order", "Match / take", "Place order (cold)", "Init market"];
interface TxInfo { op: string; cu: number | null; fee: number; status: string; tokenCalls: number; tornaCalls: number; logs: string[]; }

async function decodeTx(conn: Connection, sig: string): Promise<TxInfo | null> {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  const meta = tx.meta;
  const msg = tx.transaction.message as unknown as { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[]; compiledInstructions?: { programIdIndex: number; data: Uint8Array }[]; instructions?: { programIdIndex: number; data: string }[] };
  const keysArr = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const instrs = msg.compiledInstructions ?? msg.instructions ?? [];
  let op = -1;
  for (const ins of instrs) {
    if (keysArr[ins.programIdIndex]?.toBase58() === MARKET.orderbookProgramId) {
      const d = ins.data as Uint8Array | string;
      const byte0 = typeof d === "string" ? b58decode(d)[0] : d[0];
      op = byte0; break;
    }
  }
  const logs = meta?.logMessages ?? [];
  return {
    op: op >= 0 && op < OPS.length ? OPS[op] : "Transaction",
    cu: meta?.computeUnitsConsumed ?? null, fee: meta?.fee ?? 0, status: meta?.err ? "failed" : "success",
    tokenCalls: logs.filter((l) => l.includes(TOKEN_PROGRAM) && l.includes("invoke")).length,
    tornaCalls: logs.filter((l) => l.includes(MARKET.tornaProgramId) && l.includes("invoke")).length,
    logs,
  };
}

function TxDetail({ sig }: { sig: string }) {
  const [info, setInfo] = useState<TxInfo | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    decodeTx(connection(), sig).then((i) => { if (alive) { if (i) setInfo(i); else setErr(true); } }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [sig]);
  if (err) return <div className="px-4 py-3 text-xs text-faint">could not load transaction</div>;
  if (!info) return <div className="px-4 py-3 text-xs text-faint">decoding…</div>;
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">{info.op}</span>
        <span className={`text-xs font-semibold ${info.status === "failed" ? "text-ask" : "text-bid"}`}>{info.status}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["compute units", info.cu?.toLocaleString() ?? "-"], ["fee (lamports)", info.fee.toLocaleString()], ["token CPIs", String(info.tokenCalls)], ["engine CPIs", String(info.tornaCalls)]].map(([k, v]) => (
          <div key={k}><div className="text-[10px] uppercase tracking-wide text-faint">{k}</div><div className="nums text-sm font-semibold text-fg">{v}</div></div>
        ))}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-faint">program log (CPI evidence)</div>
        <pre className="nums mt-1 max-h-44 overflow-auto rounded-lg border border-line bg-bg/60 p-2.5 text-[10px] leading-relaxed text-muted">{info.logs.join("\n")}</pre>
      </div>
      <a href={explorerTx(sig)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand hover:text-brand-hi">open on Solana Explorer <ExternalLink className="h-3 w-3" aria-hidden /></a>
    </div>
  );
}

function RecentTxns() {
  const [sigs, setSigs] = useState<Sig[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      const j = await res.json();
      setSigs((j.rows ?? []).map((r: { sig: string; slot: number; err: boolean; blockTime: number | null; op: number; isBuy: boolean; price?: string; size?: string }) =>
        ({ signature: r.sig, slot: r.slot, err: r.err, blockTime: r.blockTime, op: r.op, isBuy: r.isBuy, price: r.price, size: r.size })));
    } catch { /* keep last */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const id = setInterval(() => { if (!document.hidden) load(); }, 20000); return () => clearInterval(id); }, [load]);
  const ago = (t: number | null) => { if (!t) return ""; const s = Math.max(0, Math.floor(Date.now() / 1000 - t)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <div className="flex items-center justify-between border-b border-line bg-panel-hi px-4 py-2.5">
        <span className="text-sm font-semibold text-fg">Recent activity</span>
        <span className="text-xs text-faint">{loading ? "loading" : "click to decode"}</span>
      </div>
      <div className="divide-y divide-line/60">
        {sigs.map((s) => (
          <Fragment key={s.signature}>
            <button onClick={() => setOpen(open === s.signature ? null : s.signature)} className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm transition-colors duration-100 hover:bg-panel-hi ${open === s.signature ? "bg-panel-hi" : ""}`}>
              <span className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${s.op === 2 ? "bg-brand/10 text-brand" : "bg-panel-hi text-muted"}`}>{OP_LABEL[s.op] ?? "tx"}</span>
                {s.price !== undefined ? (
                  <span className={`nums text-xs ${s.err ? "text-faint line-through" : s.isBuy ? "text-bid" : "text-ask"}`}>{s.isBuy ? "buy" : "sell"} {s.size} @ {s.price}</span>
                ) : (
                  <span className="nums text-xs text-faint">{s.op === 1 ? "cancel" : "tx"}</span>
                )}
              </span>
              <span className="nums flex items-center gap-3 text-faint">
                <span>slot {s.slot.toLocaleString()}</span><span>{ago(s.blockTime)}</span>
              </span>
            </button>
            {open === s.signature && <div className="border-t border-line/50 bg-bg-soft"><TxDetail sig={s.signature} /></div>}
          </Fragment>
        ))}
        {!loading && sigs.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">no recent transactions</div>}
      </div>
    </div>
  );
}

export function Explorer() {
  const [ask, setAsk] = useState<SideView | null>(null);
  const [bid, setBid] = useState<SideView | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [tab, setTab] = useState<"ask" | "bid">("ask");
  const [q, setQ] = useState("");
  const [decoded, setDecoded] = useState<Decoded | { kind: "none" } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = reader(connection());
      const [a, b, bv, qv, bd, qd] = await Promise.all([
        readSide(r, askTree(), keys.Side.Ask), readSide(r, bidTree(), keys.Side.Bid),
        tokenAmount(r, MARKET.baseVault), tokenAmount(r, MARKET.quoteVault),
        mintDecimals(r, MARKET.baseMint), mintDecimals(r, MARKET.quoteMint),
      ]);
      setAsk(a); setBid(b); setOv({ baseVault: bv, quoteVault: qv, baseDec: bd, quoteDec: qd }); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const id = setInterval(() => { if (!document.hidden) load(); }, 20000); const v = () => { if (!document.hidden) load(); }; document.addEventListener("visibilitychange", v); return () => { clearInterval(id); document.removeEventListener("visibilitychange", v); }; }, [load]);

  // resolve a pasted address into a decoded account view
  const pasted = useMemo(() => { try { return q.trim().length >= 32 ? new PublicKey(q.trim()) : null; } catch { return null; } }, [q]);
  useEffect(() => {
    if (!pasted) { setDecoded(null); return; }
    let alive = true;
    inspect(connection(), pasted).then((d) => { if (alive) setDecoded(d); }).catch(() => { if (alive) setDecoded({ kind: "none" }); });
    return () => { alive = false; };
  }, [pasted]);

  const side = tab === "ask" ? ask : bid;
  const bestAsk = ask?.orders[0]?.price;
  const bestBid = bid?.orders[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;
  const totalOrders = (ask?.orders.length ?? 0) + (bid?.orders.length ?? 0);

  const filtered = useMemo(() => {
    if (!side) return [];
    const t = q.trim().toLowerCase();
    if (!t || pasted) return side.orders;
    return side.orders.filter((o) => o.price.toString().includes(t) || o.maker.toLowerCase().includes(t) || o.keyHex.includes(t));
  }, [side, q, pasted]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Paste any account to decode it, or filter orders by price / maker / key"
            className="w-full rounded-lg border border-line bg-panel py-2 pl-9 pr-3 text-sm outline-none transition-colors duration-100 focus:border-brand" />
        </div>
        <span className="flex items-center gap-1.5 text-xs text-faint">{loading && <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />} {loading ? "reading on-chain" : "live, every 20s"}</span>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-muted transition-colors duration-100 hover:border-muted hover:text-fg active:translate-y-px"><RefreshCw className="h-3 w-3" aria-hidden /> Refresh</button>
      </div>

      {/* account inspector (when a valid address is pasted) */}
      {pasted && (
        <div className="rounded-xl border border-brand/30 bg-brand/[0.04] p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-brand">{decoded ? (decoded.kind === "none" ? "Account not found" : decoded.kind) : "decoding"}</span>
            <a href={explorerAddr(pasted.toBase58())} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-muted hover:text-fg">on Solana Explorer <ExternalLink className="h-3 w-3" aria-hidden /></a>
          </div>
          <div className="nums mb-3 break-all text-xs text-faint">{pasted.toBase58()}</div>
          {decoded && decoded.kind !== "none" && "fields" in decoded && <FieldRows rows={decoded.fields} />}
        </div>
      )}

      {error && <div className="rounded-lg border border-ask/40 bg-ask/5 px-4 py-3 text-sm text-ask">RPC error: {error}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Best bid / ask" value={`${bestBid?.toString() ?? "-"} / ${bestAsk?.toString() ?? "-"}`} sub={spread !== undefined ? `spread ${spread}` : ""} />
        <Metric label="Resting orders" value={totalOrders} sub={`${ask?.orders.length ?? 0} ask, ${bid?.orders.length ?? 0} bid`} />
        <Metric label="Base escrowed" value={ov ? ov.baseVault.toLocaleString() : "-"} sub="locked in the base vault" />
        <Metric label="Quote escrowed" value={ov ? ov.quoteVault.toLocaleString() : "-"} sub="locked in the quote vault" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <AccountsTable ov={ov} />
        <RecentTxns />
      </div>

      <div>
        <div className="mb-3 flex items-center gap-2">
          <div className="flex rounded-lg border border-line p-0.5 text-sm">
            <button onClick={() => setTab("ask")} className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors duration-100 ${tab === "ask" ? "bg-panel-hi font-medium text-ask" : "text-muted hover:text-fg"}`}><ArrowDownUp className="h-3.5 w-3.5" aria-hidden /> Ask tree</button>
            <button onClick={() => setTab("bid")} className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors duration-100 ${tab === "bid" ? "bg-panel-hi font-medium text-bid" : "text-muted hover:text-fg"}`}><Boxes className="h-3.5 w-3.5" aria-hidden /> Bid tree</button>
          </div>
          <span className="text-xs text-faint">{tab === "ask" ? "ascending price" : "descending price"}</span>
        </div>
        {side ? (
          <div className="space-y-3">
            <HeaderStats h={side.header} />
            <div className="rounded-xl border border-line bg-panel p-5"><TreeView header={side.header} leaves={side.leaves} side={tab} /></div>
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
