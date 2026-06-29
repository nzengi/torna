// The moat in one figure: the same three makers, two data structures. Left, the usual on-chain book is
// one big account, so every write hits the same account and they serialize across three slots. Right,
// Torna puts each B+ tree node in its own account, so writes at different prices touch different
// accounts and the scheduler commits all three in one slot.
const PAR = "var(--parallel)";
const SER = "var(--serial)";
const LINE = "var(--line)";
const FG = "var(--fg)";
const MUTED = "var(--muted)";
const FAINT = "var(--faint)";

function Maker({ x, y, price, color }: { x: number; y: number; price: string; color: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={9} fill={`color-mix(in srgb, ${color} 22%, var(--panel))`} stroke={color} strokeWidth={1.4} />
      <text x={x} y={y + 3.5} textAnchor="middle" fontSize="9" fontWeight="700" fill={color}>$</text>
      <text x={x} y={y - 15} textAnchor="middle" fontSize="11" className="nums" fill={MUTED}>{price}</text>
    </g>
  );
}
function Box({ x, y, w, h = 38, title, sub, color }: { x: number; y: number; w: number; h?: number; title: string; sub: string; color: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={7} fill={`color-mix(in srgb, ${color} 8%, var(--panel))`} stroke={color} strokeWidth={1.4} />
      <text x={x + w / 2} y={y + 16} textAnchor="middle" fontSize="11" fontWeight="600" fill={FG}>{title}</text>
      <text x={x + w / 2} y={y + 29} textAnchor="middle" fontSize="9" fill={MUTED}>{sub}</text>
    </g>
  );
}

export function Mechanism() {
  const drop = (x1: number, y1: number, x2: number, y2: number) => (
    <path d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`} fill="none" stroke={LINE} strokeWidth={1.4} />
  );
  return (
    <svg viewBox="0 0 760 340" className="w-full min-w-[660px]" role="img" aria-label="Three makers whose prices fall in different leaves: a single-slab book serializes them across three slots, while Torna's one-account-per-leaf layout commits all three in one slot">
      <line x1={380} y1={20} x2={380} y2={324} stroke={LINE} strokeWidth={1} strokeDasharray="3 4" />

      {/* ===== LEFT: the classic single-account book (serial) ===== */}
      <text x={180} y={18} textAnchor="middle" fontSize="12" fontWeight="700" fill={SER}>The usual book</text>
      <text x={180} y={33} textAnchor="middle" fontSize="10" fill={FAINT}>one slab account per side</text>
      <Maker x={60} y={70} price="100" color={SER} />
      <Maker x={180} y={70} price="180" color={SER} />
      <Maker x={300} y={70} price="260" color={SER} />
      {/* all three converge to the single account */}
      {drop(60, 79, 180, 132)}
      {drop(180, 79, 180, 132)}
      {drop(300, 79, 180, 132)}
      <Box x={108} y={132} w={144} title="one slab" sub="one account, one lock" color={SER} />
      {/* three stacked slots */}
      {drop(180, 170, 180, 200)}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={50} y={200 + i * 24} width={260} height={18} rx={4} fill={`color-mix(in srgb, ${SER} 12%, var(--panel))`} stroke={SER} strokeWidth={1.2} />
          <text x={62} y={200 + i * 24 + 13} fontSize="9" className="nums" fill={FAINT}>slot {i + 1}</text>
          <rect x={120} y={200 + i * 24 + 3} width={180} height={12} rx={2} fill={SER} opacity={0.8} />
        </g>
      ))}
      <text x={180} y={300} textAnchor="middle" fontSize="12" fontWeight="600" fill={FG}>3 orders, 3 slots</text>
      <text x={180} y={316} textAnchor="middle" fontSize="10" fill={SER}>one shared account serializes them</text>

      {/* ===== RIGHT: Torna, one node per account (parallel) ===== */}
      <text x={580} y={18} textAnchor="middle" fontSize="12" fontWeight="700" fill={PAR}>Torna</text>
      <text x={580} y={33} textAnchor="middle" fontSize="10" fill={FAINT}>prices that fall in different leaves</text>
      <Maker x={460} y={70} price="100" color={PAR} />
      <Maker x={580} y={70} price="180" color={PAR} />
      <Maker x={700} y={70} price="260" color={PAR} />
      {/* each maker straight down to its own leaf */}
      {drop(460, 79, 460, 132)}
      {drop(580, 79, 580, 132)}
      {drop(700, 79, 700, 132)}
      <Box x={412} y={132} w={96} title="leaf" sub="account A" color={PAR} />
      <Box x={532} y={132} w={96} title="leaf" sub="account B" color={PAR} />
      <Box x={652} y={132} w={96} title="leaf" sub="account C" color={PAR} />
      {/* all into one slot */}
      {drop(460, 170, 580, 232)}
      {drop(580, 170, 580, 232)}
      {drop(700, 170, 580, 232)}
      <rect x={440} y={232} width={280} height={34} rx={7} fill={`color-mix(in srgb, ${PAR} 12%, var(--panel))`} stroke={PAR} strokeWidth={1.4} />
      <text x={456} y={253} fontSize="10" className="nums" fill={FAINT}>slot 1</text>
      {[550, 580, 610].map((cx) => <rect key={cx} x={cx} y={241} width={18} height={16} rx={3} fill={PAR} opacity={0.85} />)}
      <text x={580} y={300} textAnchor="middle" fontSize="12" fontWeight="600" fill={FG}>3 orders, 1 slot</text>
      <text x={580} y={316} textAnchor="middle" fontSize="10" fill={PAR}>disjoint accounts run in parallel</text>
    </svg>
  );
}
