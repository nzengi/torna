// The 32-byte order key, big-endian, that makes byte-lexicographic order == price-time priority.
const SEGS = [
  { bytes: "0–8", label: "price", note: "ask: price · bid: MAX−price", w: 30 },
  { bytes: "8–16", label: "slot", note: "approx. time priority", w: 26 },
  { bytes: "16–24", label: "maker[0..8]", note: "writer-unique", w: 26 },
  { bytes: "24–32", label: "nonce", note: "no parallel collision", w: 18 },
];

export function OrderKey() {
  return (
    <div>
      <div className="flex overflow-hidden rounded-lg border border-line">
        {SEGS.map((s, i) => (
          <div
            key={s.label}
            className={`flex flex-col gap-0.5 px-3 py-2.5 ${i > 0 ? "border-l border-line" : ""} ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}
            style={{ width: `${s.w}%` }}
          >
            <span className="nums text-[10px] text-faint">bytes {s.bytes}</span>
            <span className="text-sm font-medium text-fg">{s.label}</span>
            <span className="text-[11px] leading-tight text-muted">{s.note}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">
        Compared byte-by-byte, this single key sorts the whole book into price-then-time priority —
        the tree stays sorted with no extra index.
      </p>
    </div>
  );
}
