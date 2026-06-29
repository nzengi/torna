import Link from "next/link";
import { ArrowRight, Boxes, GitBranch, Layers, Zap } from "lucide-react";
import { BTree } from "@/components/diagrams/BTree";
import { OrderKey } from "@/components/diagrams/OrderKey";
import { Parallelism } from "@/components/Parallelism";
import { Compare } from "@/components/Compare";
import { Reveal } from "@/components/Reveal";

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="hero-glow pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="mx-auto max-w-6xl px-6 pt-20 pb-16">
        <p className="enter mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
          Sorted on-chain state, without the slab
        </p>
        <h1 className="enter display max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl" style={{ animationDelay: "70ms" }}>
          A parallel, ordered <span className="text-gradient">order book</span>, fully on Solana.
        </h1>
        <p className="enter mt-6 max-w-2xl text-lg leading-relaxed text-muted" style={{ animationDelay: "140ms" }}>
          TornaDEX is a central limit order book built on <span className="font-medium text-fg">Torna</span>,
          a B+ tree index where every node lives in its own account. Makers quoting at different prices
          write to different accounts, so the Solana scheduler runs their orders in parallel, no slab,
          no off-chain indexer.
        </p>
        <div className="enter mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "210ms" }}>
          <Link href="/trade" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
            Launch the live demo <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link href="/docs" className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px">
            Read the docs
          </Link>
          <code className="nums rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">npm i torna-sdk</code>
        </div>
        <p className="mt-4 text-xs text-faint">Live on devnet · in-house adversarial-reviewed · external audit pending.</p>
        </div>
      </section>

      {/* The problem */}
      <section className="border-y border-line bg-bg-soft">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="display text-3xl font-semibold tracking-tight">Why on-chain order books are hard</h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
            Solana programs are limited by three scarce resources. A classic single-account slab order
            book loses on all three. Torna is designed around them.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {[
              { icon: Layers, t: "Account budget", d: "A tx can touch a limited number of accounts. High fanout means ~3 node accounts per operation, not one huge slab." },
              { icon: Zap, t: "Parallelism (Sealevel)", d: "Txs that touch disjoint accounts run together. One node per account means disjoint-key writes never collide." },
              { icon: Boxes, t: "Rent", d: "Every account costs rent. Node size is tuned to the value, and high fanout amortizes the per-account overhead." },
            ].map((c) => (
              <div key={c.t} className="rounded-xl border border-line bg-panel p-5">
                <c.icon className="h-5 w-5 text-brand" aria-hidden />
                <h3 className="mt-3 text-sm font-semibold text-fg">{c.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
          <GitBranch className="h-4 w-4" aria-hidden /> How it works
        </div>
        <h2 className="display max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          One B+ tree. One account per node.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          The book is a sorted B+ tree. The header is read-only on the hot path; only the target leaf
          is writable. So two makers landing in different leaves carry disjoint write sets and commit
          in the same slot.
        </p>
        <Reveal className="mt-8 rounded-xl border border-line bg-panel p-6 sm:p-8">
          <BTree />
        </Reveal>
      </section>

      {/* Parallelism (the moat) */}
      <Parallelism />

      {/* Slab vs Torna */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="display text-3xl font-semibold tracking-tight">Torna replaces two things</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Teams hand-write a slab allocator and run an off-chain indexer to read it back. Torna is both:
          an audited on-chain index plus a client that resolves every account for you.
        </p>
        <Reveal className="mt-8">
          <Compare />
        </Reveal>
      </section>

      {/* It's a real CLOB */}
      <section className="border-t border-line bg-bg-soft">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="display text-3xl font-semibold tracking-tight">A real CLOB, not a toy</h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
            Each resting order is one tree entry. A single 32-byte key encodes price-time priority, so
            the tree is the sorted book. Real SPL-token escrow backs every order; matching settles
            atomically.
          </p>
          <Reveal className="mt-8 max-w-3xl">
            <OrderKey />
          </Reveal>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/trade" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
              Place a live order <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/explorer" className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px">
              Inspect the on-chain tree
            </Link>
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="glass neon-glow relative overflow-hidden rounded-2xl px-8 py-12 sm:px-12">
          <div className="brand-gradient pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full opacity-25 blur-3xl" aria-hidden />
          <h2 className="display relative text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
            Build on <span className="text-gradient">Torna</span>
          </h2>
          <p className="relative mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
            The engine is deployed and the SDK is on npm. Resolve accounts off-chain and ship a parallel,
            ordered, sorted index without the slab or an indexer.
          </p>
          <div className="relative mt-7 flex flex-wrap items-center gap-3">
            <Link href="/trade" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
              Try the live demo <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/docs" className="inline-flex items-center gap-2 rounded-lg border border-line px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:bg-panel-hi active:translate-y-px">
              Read the docs
            </Link>
            <code className="nums rounded-lg border border-line bg-panel-hi px-3 py-2 text-xs text-muted">npm i torna-sdk</code>
          </div>
        </div>
      </section>
    </>
  );
}
