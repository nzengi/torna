// Act 2 -- the headline. Honest framing: parallel BOOK MAINTENANCE, not matching. The ratio is
// measured on a single-node validator's real banking stage (torna/bench); devnet is shared, so
// the controlled number is the honest one. The diagram shows the mechanism: disjoint price
// levels -> disjoint leaves -> one slot; same price -> one leaf -> serialized.

function Lane({ label, kind, blocks }: { label: string; kind: "parallel" | "serial"; blocks: number }) {
  const color = kind === "parallel" ? "bg-parallel" : "bg-serial";
  const slots = kind === "parallel" ? 1 : blocks;
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-faint">
          {blocks} tx · <span className={kind === "parallel" ? "text-parallel" : "text-serial"}>{slots} slot{slots > 1 ? "s" : ""}</span>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: slots }).map((_, s) => (
          <div key={s} className="flex items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] text-faint">slot {s + 1}</span>
            <div className="flex flex-1 gap-1">
              {Array.from({ length: kind === "parallel" ? blocks : 1 }).map((_, b) => (
                <div key={b} className={`h-5 flex-1 rounded-sm ${color} opacity-80`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Parallelism() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-14">
      <div className="mb-2 text-xs uppercase tracking-[0.2em] text-brand">The moat</div>
      <h2 className="text-2xl font-semibold tracking-tight">Maker traffic parallelizes</h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        Six makers, identical compute. When they quote across different price levels their orders land
        in different leaves (different accounts) and commit in one slot. When they all hit the same
        price they share one leaf and serialize.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Lane label="Quote across prices (disjoint leaves)" kind="parallel" blocks={6} />
        <Lane label="All at one price (same leaf)" kind="serial" blocks={6} />
      </div>

      <div className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-lg border border-line bg-panel p-5">
        <div>
          <span className="nums text-3xl font-semibold text-parallel">3.4–6×</span>
          <span className="ml-2 text-sm text-muted">more committed tx / slot, disjoint vs. same-leaf</span>
        </div>
        <p className="text-xs leading-relaxed text-faint">
          Measured on a single-node solana-test-validator (the real Agave banking stage) via
          torna/bench. Devnet is shared and noisy, so the controlled number is the honest one. This
          parallelizes book <span className="text-fg">maintenance</span>, not matching — top-of-book is
          price-time serial by definition.
        </p>
      </div>
    </section>
  );
}
