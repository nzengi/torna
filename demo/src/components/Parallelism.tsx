// The moat, shown not told: a price is a key in the B+ tree and every node is its own account, so
// disjoint prices touch disjoint accounts and commit in one slot. The ratio is measured on a
// single-node validator's real banking stage (torna/bench); it is BOOK MAINTENANCE, not matching.
import { Mechanism } from "@/components/diagrams/Mechanism";

export function Parallelism() {
  return (
    <section className="border-y border-line bg-bg-soft">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">The moat</div>
        <h2 className="display max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Why the writes run in parallel
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          The usual on-chain book is one big account, so every order hits the same account and they
          serialize, one per slot. Torna puts each B+ tree node in its own account, so orders at different
          prices touch different accounts and Solana commits them in the same slot.
        </p>

        <figure className="mt-8">
          <div className="overflow-x-auto rounded-xl border border-line bg-panel p-5 sm:p-7">
            <Mechanism />
          </div>
        </figure>

        <div className="glass neon-glow mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl p-6">
          <div className="flex items-baseline gap-2">
            <span className="nums display text-gradient text-4xl font-semibold">3.4-6x</span>
            <span className="text-sm text-muted">more committed tx / slot<br />disjoint vs. same-leaf</span>
          </div>
          <p className="max-w-xl flex-1 text-xs leading-relaxed text-faint">
            Measured on a single-node solana-test-validator, the real Agave banking stage, via
            <span className="font-medium text-fg"> torna/bench</span>. Devnet is shared and noisy, so the
            controlled number is the honest one. This parallelizes book{" "}
            <span className="font-semibold text-fg">maintenance</span>, not matching: top-of-book is
            price-time serial by definition, and nothing can change that.
          </p>
        </div>
      </div>
    </section>
  );
}
