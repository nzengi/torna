// Core "aha" schema: a B+ tree where every node is its own Solana account. Two makers quoting
// at different prices descend to DIFFERENT leaves -> disjoint writable accounts -> the Sealevel
// scheduler runs both writes in the SAME slot. The header is read-only on the hot path.
const ink = "var(--ink)";
const line = "var(--line)";
const panel = "var(--panel)";
const muted = "var(--muted)";
const brand = "var(--brand)";
const bid = "var(--bid)";

function Box({
  x, y, w = 120, h = 40, label, sub, accent,
}: { x: number; y: number; w?: number; h?: number; label: string; sub?: string; accent?: boolean }) {
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx={7}
        fill={accent ? "color-mix(in srgb, var(--brand) 10%, var(--panel))" : panel}
        stroke={accent ? brand : line} strokeWidth={accent ? 2 : 1.25}
      />
      <text x={x + w / 2} y={y + (sub ? h / 2 - 2 : h / 2 + 4)} textAnchor="middle"
        fontSize="13" fontWeight="600" fill={accent ? brand : ink}>{label}</text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" fontSize="9.5" fill={muted}>{sub}</text>
      )}
    </g>
  );
}

export function BTree() {
  const L = (x1: number, y1: number, x2: number, y2: number, hot?: boolean) => (
    <path d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`}
      className={hot ? "hot-path" : undefined}
      fill="none" stroke={hot ? brand : line} strokeWidth={hot ? 2 : 1.25} strokeDasharray={hot ? undefined : "4 3"} />
  );
  const leaves = [60, 215, 370, 525];
  return (
    <svg viewBox="0 0 720 300" className="w-full" role="img" aria-label="B+ tree: one node per account, disjoint-key writes parallelize">
      {/* header (read-only on the hot path) */}
      <Box x={290} y={10} w={140} h={42} label="Tree header" sub="read-only on hot path" />
      {/* internal node */}
      <Box x={290} y={110} w={140} h={42} label="Internal node" sub="own account" />
      {/* connectors header->internal->leaves */}
      {L(360, 52, 360, 110)}
      {L(360, 152, leaves[0] + 65, 210)}
      {L(360, 152, leaves[1] + 65, 210, true)}
      {L(360, 152, leaves[2] + 65, 210)}
      {L(360, 152, leaves[3] + 65, 210, true)}
      {/* leaves */}
      {leaves.map((x, i) => (
        <Box key={i} x={x} y={210} w={130} h={44} label={`Leaf ${i + 1}`} sub={`prices ${["100–104", "105–109", "110–114", "115+"][i]}`} accent={i === 1 || i === 3} />
      ))}
      {/* maker badges */}
      <g>
        <rect x={leaves[1] + 18} y={266} width={94} height={22} rx={11} fill="color-mix(in srgb, var(--brand) 12%, var(--panel))" stroke={brand} />
        <text x={leaves[1] + 65} y={281} textAnchor="middle" fontSize="11" fill={brand} fontWeight="600">maker A → 106</text>
        <rect x={leaves[3] + 18} y={266} width={94} height={22} rx={11} fill="color-mix(in srgb, var(--brand) 12%, var(--panel))" stroke={brand} />
        <text x={leaves[3] + 65} y={281} textAnchor="middle" fontSize="11" fill={brand} fontWeight="600">maker B → 117</text>
      </g>
      {/* same-slot badge */}
      <g>
        <rect x={500} y={60} width={196} height={40} rx={8} fill="color-mix(in srgb, var(--bid) 10%, var(--panel))" stroke={bid} />
        <text x={598} y={77} textAnchor="middle" fontSize="12" fontWeight="600" fill={bid}>disjoint accounts</text>
        <text x={598} y={92} textAnchor="middle" fontSize="11" fill={muted}>→ committed in ONE slot</text>
      </g>
    </svg>
  );
}
