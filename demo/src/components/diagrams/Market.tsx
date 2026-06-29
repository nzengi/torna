// A market = two Torna trees (ask/bid) + two SPL vaults + a config, all owned/bound by ONE book PDA
// (the trees' sole write authority). Shows the binding the orderbook's check_book enforces.
const ink = "var(--fg)";
const line = "var(--line)";
const panel = "var(--panel)";
const muted = "var(--muted)";
const bid = "var(--bid)";
const ask = "var(--ask)";
const brand = "var(--brand)";

function Box({ x, y, w, h = 46, label, sub, color }: { x: number; y: number; w: number; h?: number; label: string; sub?: string; color?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={color ? `color-mix(in srgb, ${color} 10%, var(--panel))` : panel} stroke={color ?? line} strokeWidth={color ? 1.6 : 1.25} />
      <text x={x + w / 2} y={y + (sub ? h / 2 - 2 : h / 2 + 4)} textAnchor="middle" fontSize="12.5" fontWeight="600" fill={color ?? ink}>{label}</text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" fontSize="9.5" fill={muted}>{sub}</text>}
    </g>
  );
}

export function Market() {
  const L = (x1: number, y1: number, x2: number, y2: number) => (
    <path d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`} fill="none" stroke={line} strokeWidth={1.25} />
  );
  const kids = [
    { x: 20, label: "Ask tree", sub: "ascending price", color: ask },
    { x: 195, label: "Bid tree", sub: "descending price", color: bid },
    { x: 370, label: "Base vault", sub: "ask escrow" },
    { x: 545, label: "Quote vault", sub: "bid escrow" },
  ];
  return (
    <svg viewBox="0 0 720 250" className="w-full" role="img" aria-label="Market structure: a book PDA owns two trees and two vaults, bound by a config">
      <Box x={250} y={12} w={220} h={50} label="Book authority (PDA)" sub="sole writer of both trees + vault owner" color={brand} />
      {/* cfg on the side, binds everything */}
      <Box x={510} y={12} w={190} h={50} label="Market config (cfg)" sub="binds mints, vaults, trees" />
      <path d={`M470,37 L510,37`} fill="none" stroke={line} strokeWidth={1.25} strokeDasharray="4 3" />
      {kids.map((k) => L(360, 62, k.x + 75, 150))}
      {kids.map((k) => (
        <Box key={k.label} x={k.x} y={150} w={150} label={k.label} sub={k.sub} color={k.color} />
      ))}
    </svg>
  );
}
