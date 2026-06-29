// The headline, honest: parallel BOOK MAINTENANCE, not matching. The ratio is measured on a
// single-node validator's real banking stage (torna/bench); devnet is shared, so the controlled
// number is the honest one. Mechanism: disjoint price levels -> disjoint leaves -> one slot.

function Scenario({ kind, title, subtitle }: { kind: "parallel" | "serial"; title: string; subtitle: string }) {
  const slots = kind === "parallel" ? 1 : 6;
  const color = kind === "parallel" ? "bg-parallel" : "bg-serial";
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${color}`} aria-hidden />
        <span className="text-sm font-semibold text-fg">{title}</span>
      </div>
      <p className="mb-4 text-xs text-muted">{subtitle}</p>
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: slots }).map((_, s) => (
          <div key={s} className="flex items-center gap-2">
            <span className="nums w-12 shrink-0 text-[10px] text-faint">slot {s + 1}</span>
            <div className="flex flex-1 gap-1">
              {Array.from({ length: kind === "parallel" ? 6 : 1 }).map((_, b) => (
                <div key={b} className={`h-6 flex-1 rounded ${color} opacity-85`} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-faint">
        6 maker orders → <span className="font-medium text-fg">{slots} slot{slots > 1 ? "s" : ""}</span>
      </p>
    </div>
  );
}

export function Parallelism() {
  return (
    <section className="border-y border-line bg-bg-soft">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">The moat</div>
        <h2 className="display max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Maker traffic runs in parallel
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          Six makers, identical compute. Quoting across different price levels puts each order in a
          different leaf, a different account, so the Solana scheduler commits them in one slot.
          All at the same price means one shared leaf, so they serialize across six slots.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Scenario kind="parallel" title="Quote across prices" subtitle="disjoint leaves → parallel" />
          <Scenario kind="serial" title="All at one price" subtitle="same leaf → serialized" />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-line bg-panel p-6">
          <div className="flex items-baseline gap-2">
            <span className="nums display text-4xl font-semibold text-brand">3.4–6×</span>
            <span className="text-sm text-muted">more committed tx / slot<br />disjoint vs. same-leaf</span>
          </div>
          <p className="max-w-xl flex-1 text-xs leading-relaxed text-faint">
            Measured on a single-node solana-test-validator, the real Agave banking stage, via
            <span className="text-muted"> torna/bench</span>. Devnet is shared and noisy, so the
            controlled number is the honest one. This parallelizes book{" "}
            <span className="font-medium text-fg">maintenance</span>, not matching: top-of-book is
            price-time serial by definition, and nothing can change that.
          </p>
        </div>
      </div>
    </section>
  );
}
