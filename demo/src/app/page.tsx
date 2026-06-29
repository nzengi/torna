import Link from "next/link";
import { ArrowRight, BarChart3, Boxes, Code2, Compass, FileText, ListOrdered, Trophy, Vote } from "lucide-react";
import { GithubIcon } from "@/components/ui/GithubIcon";
import { LiveMarket } from "@/components/LiveMarket";
import { Parallelism } from "@/components/Parallelism";

const GH = "https://github.com/nzengi/torna";

export default function Home() {
  return (
    <>
      {/* Hero: problem first, then the insight */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="hero-glow pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="mx-auto max-w-3xl px-6 pt-24 pb-16 text-center">
          <p className="enter text-xs font-semibold uppercase tracking-[0.2em] text-brand">An on-chain index primitive for Solana</p>
          <h1 className="enter display mt-4 text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl" style={{ animationDelay: "70ms" }}>
            Sorted on-chain state that <span className="text-gradient">writes in parallel</span>.
          </h1>
          <p className="enter mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted" style={{ animationDelay: "140ms" }}>
            On Solana, keeping state sorted usually means one giant account that serializes every write,
            plus an off-chain indexer to read it back. <span className="font-medium text-fg">Torna</span> is
            a B+ tree with one node per account, so writes that land in different leaves commit in the same
            slot. No slab, no indexer.
          </p>
          <div className="enter mt-8 flex flex-wrap items-center justify-center gap-3" style={{ animationDelay: "210ms" }}>
            <Link href="/build" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
              Build on Torna <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/docs" className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px">
              Read the docs
            </Link>
          </div>
          <p className="mt-5 text-xs text-faint">Live on devnet · SDKs on npm and crates.io · internally reviewed, external audit pending</p>
        </div>
      </section>

      {/* The moat: parallelism, with the honest caveat (4.6-7.1x lives here) */}
      <Parallelism />

      {/* What you build on it */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h2 className="display text-3xl font-semibold tracking-tight">Build anything sorted</h2>
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
            Anything that needs sorted state with many concurrent writers maps onto one tree. You choose
            what the key and value mean.
          </p>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: BarChart3, t: "Order books", d: "Price-time priority, parallel maker quotes (matching stays serial), real escrow." },
            { icon: ListOrdered, t: "Liquidation queues", d: "Sorted by health; keepers pop the worst, borrowers update in parallel." },
            { icon: Trophy, t: "Leaderboards", d: "Top-N with cheap reads and concurrent score updates." },
            { icon: Vote, t: "Governance", d: "Sorted stake or votes, queryable on-chain without an indexer." },
            { icon: Boxes, t: "Expiry queues", d: "Ordered by deadline; the soonest to expire is the leftmost leaf." },
            { icon: Code2, t: "Your sorted index", d: "Generic key to value, value up to 128 bytes per entry." },
          ].map((c) => (
            <div key={c.t} className="rounded-xl border border-line bg-panel p-5 transition-colors duration-150 hover:border-brand/40">
              <c.icon className="h-5 w-5 text-brand" aria-hidden />
              <h3 className="mt-3 text-sm font-semibold text-fg">{c.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{c.d}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/build" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-hi">See how to build one, in TypeScript or Rust <ArrowRight className="h-4 w-4" aria-hidden /></Link>
        </div>
      </section>

      {/* Proof it works: TornaDEX (subordinate, the reference integration) */}
      <section className="border-y border-line bg-bg-soft">
        <div className="mx-auto max-w-6xl px-6 py-16 lg:grid lg:grid-cols-2 lg:items-center lg:gap-12">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Proof it works</div>
            <h2 className="display mt-2 text-3xl font-semibold tracking-tight">We built a full order book on it</h2>
            <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted">
              TornaDEX is a central limit order book built entirely on Torna: real SPL-token escrow, place,
              cancel, and match as real on-chain transactions, live on devnet. It is the reference
              integration that proves the primitive end to end, not the product.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <Link href="/trade" className="inline-flex items-center gap-1.5 font-medium text-brand hover:text-brand-hi">Trade it live <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
              <Link href="/explorer" className="text-muted hover:text-fg">Inspect the on-chain trees</Link>
            </div>
          </div>
          <div className="mt-8 lg:mt-0"><LiveMarket /></div>
        </div>
      </section>

      {/* Explore */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="display text-center text-2xl font-semibold tracking-tight">Go deeper</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Code2, t: "Build", d: "A code-first guide, TypeScript or Rust.", href: "/build" },
            { icon: FileText, t: "Docs", d: "The primitive and the reference app, in full.", href: "/docs" },
            { icon: BarChart3, t: "Research", d: "Motivation, the model, and the measured numbers.", href: "/research" },
            { icon: Compass, t: "Explorer", d: "Decode the live on-chain trees and transactions.", href: "/explorer" },
          ].map((c) => (
            <Link key={c.t} href={c.href} className="group rounded-xl border border-line bg-panel p-5 transition-colors duration-150 hover:border-brand/40">
              <c.icon className="h-5 w-5 text-brand" aria-hidden />
              <div className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-fg">{c.t} <ArrowRight className="h-3.5 w-3.5 -translate-x-1 opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100" aria-hidden /></div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{c.d}</p>
            </Link>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
          <a href={GH} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-brand"><GithubIcon className="h-4 w-4" /> GitHub</a>
          <a href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer" className="hover:text-brand">torna-sdk on npm</a>
          <a href="https://crates.io/crates/torna-sdk" target="_blank" rel="noreferrer" className="hover:text-brand">torna-sdk on crates.io</a>
          <code className="nums rounded border border-line bg-panel px-2.5 py-1 text-xs text-muted">npm i torna-sdk</code>
        </div>
      </section>
    </>
  );
}
