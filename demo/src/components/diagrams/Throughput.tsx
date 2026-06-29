// Figure: aggregate speedup vs maker fraction, under the conflict model in the text.
// sigma_agg(m) = 1 / ((1-m) + m/sigma), the Amdahl form where m is the maintenance (maker) fraction
// of traffic and sigma is the disjoint-write speedup ceiling. The shaded band spans the measured
// sigma = 4.6 (peak slot) to 7.1 (median busy slot); the curve shows how the aggregate win depends on
// how maker-heavy the book is.
const SIGMA_HI = 7.1, SIGMA_LO = 4.6;
const Y_MAX = 8;

const sigmaAgg = (m: number, sigma: number) => 1 / ((1 - m) + m / sigma);

// plot area
const W = 580, H = 320;
const L = 52, R = 18, T = 16, B = 44;
const X = (m: number) => L + m * (W - L - R);
const Y = (s: number) => H - B - ((s - 1) / (Y_MAX - 1)) * (H - T - B);

const curve = (sigma: number) =>
  Array.from({ length: 49 }, (_, i) => { const m = i / 48; return `${X(m).toFixed(1)},${Y(sigmaAgg(m, sigma)).toFixed(1)}`; }).join(" ");

export function Throughput() {
  const band = `${curve(SIGMA_HI)} ` +
    Array.from({ length: 49 }, (_, i) => { const m = (48 - i) / 48; return `${X(m).toFixed(1)},${Y(sigmaAgg(m, SIGMA_LO)).toFixed(1)}`; }).join(" ");
  const mMark = 0.9;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Aggregate speedup versus maker fraction of traffic">
      {/* y gridlines + ticks */}
      {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
        <g key={s}>
          <line x1={L} y1={Y(s)} x2={W - R} y2={Y(s)} stroke="var(--line)" strokeWidth={1} />
          <text x={L - 8} y={Y(s) + 4} textAnchor="end" fontSize="10" className="nums" fill="var(--faint)">{s}x</text>
        </g>
      ))}
      {/* x ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((m) => (
        <text key={m} x={X(m)} y={H - B + 16} textAnchor="middle" fontSize="10" className="nums" fill="var(--faint)">{m}</text>
      ))}
      {/* measured band */}
      <polygon points={band} fill="var(--bid)" fillOpacity={0.14} stroke="none" />
      {/* sigma curves */}
      <polyline points={curve(SIGMA_HI)} fill="none" stroke="var(--bid)" strokeWidth={2} />
      <polyline points={curve(SIGMA_LO)} fill="none" stroke="var(--bid)" strokeWidth={1.5} strokeDasharray="5 3" />
      {/* maker-heavy marker */}
      <line x1={X(mMark)} y1={T} x2={X(mMark)} y2={H - B} stroke="var(--parallel)" strokeWidth={1} strokeDasharray="3 3" />
      <text x={X(mMark) - 6} y={T + 22} textAnchor="end" fontSize="10" fill="var(--parallel)">liquid, maker-heavy book</text>
      {/* labels */}
      <text x={X(0.5)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">maker (maintenance) fraction of traffic</text>
      <text x={W - R} y={Y(SIGMA_HI) - 8} textAnchor="end" fontSize="10" fill="var(--bid)">sigma = 7.1 (median busy slot)</text>
      <text x={W - R} y={Y(sigmaAgg(0.78, SIGMA_LO)) + 14} textAnchor="end" fontSize="10" fill="var(--bid)">sigma = 4.6 (peak slot)</text>
      <text x={6} y={T + 6} fontSize="10" fill="var(--muted)" transform={`rotate(-90 12 ${H / 2})`}>aggregate speedup</text>
    </svg>
  );
}
