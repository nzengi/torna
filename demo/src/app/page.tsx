import Link from "next/link";
import { ArrowRight, BarChart3, Boxes, GitBranch, Layers, ListOrdered, Trophy, Vote, Zap } from "lucide-react";
import { GithubIcon } from "@/components/ui/GithubIcon";
import { BTree } from "@/components/diagrams/BTree";
import { OrderKey } from "@/components/diagrams/OrderKey";
import { Parallelism } from "@/components/Parallelism";
import { Compare } from "@/components/Compare";
import { Reveal } from "@/components/Reveal";
import { LiveMarket } from "@/components/LiveMarket";

const GH = "https://github.com/nzengi/torna";

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="hero-glow pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="mx-auto max-w-6xl px-6 pt-20 pb-16 lg:grid lg:grid-cols-[1.55fr_1fr] lg:items-center lg:gap-12">
        <div>
        <p className="enter mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
          The on-chain index primitive for Solana
        </p>
        <h1 className="enter display max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl" style={{ animationDelay: "70ms" }}>
          A parallel, ordered <span className="text-gradient">index</span> for Solana.
        </h1>
        <p className="enter mt-6 max-w-2xl text-lg leading-relaxed text-muted" style={{ animationDelay: "140ms" }}>
          <span className="font-medium text-fg">Torna</span> is a sorted on-chain B+ tree where every node
          lives in its own account, so writes at different keys run in the same slot. Build order books,
          liquidation queues, leaderboards, governance, any sorted state with concurrent writers, no slab
          and no indexer. <span className="font-medium text-fg">TornaDEX</span>, a full order book, is the
          live reference you can trade right now.
        </p>
        <div className="enter mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "210ms" }}>
          <Link href="/trade" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
            Launch TornaDEX, the live demo <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link href="/build" className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px">
            Build on Torna
          </Link>
          <code className="nums rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">npm i torna-sdk</code>
        </div>
        <p className="mt-4 text-xs text-faint">Live on devnet · in-house adversarial-reviewed · external audit pending.</p>
        </div>
        <div className="enter mt-10 lg:mt-0" style={{ animationDelay: "280ms" }}>
          <LiveMarket />
        </div>
        </div>
      </section>

      {/* the stack */}
      <section className="border-y border-line bg-bg-soft">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-brand">One engine, a typed stack on top</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { n: "Engine", l: "C / SBF", d: "the parallel B+ tree, 15 instructions", href: GH },
              { n: "Orderbook", l: "Rust / SBF", d: "two-sided escrow CLOB", href: GH },
              { n: "torna-cpi", l: "Rust crate", d: "drive Torna from your program", href: GH },
              { n: "Rust SDK", l: "torna-sdk", d: "off-chain account planner", href: GH },
              { n: "TS SDK", l: "npm", d: "1:1 port, byte-equivalent", href: "https://www.npmjs.com/package/torna-sdk" },
            ].map((c) => (
              <a key={c.n} href={c.href} target="_blank" rel="noreferrer" className="group block">
                <div className="text-base font-semibold text-fg transition-colors duration-100 group-hover:text-brand">{c.n}</div>
                <div className="nums mt-0.5 text-[11px] font-medium text-brand">{c.l}</div>
                <div className="mt-1 text-xs leading-snug text-muted">{c.d}</div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* The problem */}
      <section className="border-y border-line bg-bg-soft">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="display text-3xl font-semibold tracking-tight">Why sorted on-chain state is hard</h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
            Solana programs are bound by three scarce resources. A classic single-account slab, the usual
            order-book design, loses on all three. Torna is built around them, so anything sorted you put
            on it inherits the win.
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

      {/* use cases */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="display text-3xl font-semibold tracking-tight">One primitive, many markets</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Anything that needs sorted state with concurrent writers maps onto Torna. The order book is the
          wedge; the same tree powers the rest.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: BarChart3, t: "CLOB / DEX order book", d: "Price-time priority, parallel maker quotes, real SPL escrow. The reference integration." },
            { icon: ListOrdered, t: "Liquidation queues", d: "Positions sorted by health; liquidators pop the worst while writers update in parallel." },
            { icon: Trophy, t: "Leaderboards / top-N", d: "Sorted scores with cheap top-N reads and concurrent updates across the board." },
            { icon: Vote, t: "Token-weight governance", d: "Sorted stake or votes, queryable on-chain without an off-chain indexer." },
            { icon: Boxes, t: "Proposal / expiry queues", d: "Ordered by deadline, so the soonest to expire is always the leftmost leaf." },
            { icon: Zap, t: "Your sorted index", d: "Generic key to value, value up to 128 bytes, fixed per tree. Bring your own market." },
          ].map((c) => (
            <div key={c.t} className="rounded-xl border border-line bg-panel p-5 transition-colors duration-150 hover:border-brand/40">
              <c.icon className="h-5 w-5 text-brand" aria-hidden />
              <h3 className="mt-3 text-sm font-semibold text-fg">{c.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{c.d}</p>
            </div>
          ))}
        </div>
      </section>

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
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">The reference app</div>
          <h2 className="display text-3xl font-semibold tracking-tight">TornaDEX, a real CLOB on Torna</h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
            The flagship example built on the primitive. Each resting order is one tree entry; a single
            32-byte key encodes price-time priority, so the tree is the sorted book. Real SPL-token escrow
            backs every order and matching settles atomically. Your own app uses the same SDK with a
            different key and value.
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

      {/* SDK teaser */}
      <section className="border-t border-line bg-bg-soft">
        <div className="mx-auto max-w-6xl px-6 py-16 lg:grid lg:grid-cols-2 lg:items-center lg:gap-12">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">Build with it</div>
            <h2 className="display text-3xl font-semibold tracking-tight sm:text-4xl">Account resolution, made invisible</h2>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
              Call with a key and a value. The planner reads the tree off-chain and returns the exact
              account set. Node indices, PDA bumps, the descent path, split spares, none of it reaches you.
              The TypeScript and Rust SDKs are byte-equivalent.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link href="/docs" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
                Read the quickstart <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <a href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px">
                torna-sdk on npm
              </a>
              <a href={GH} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px">
                <GithubIcon className="h-4 w-4" /> GitHub
              </a>
            </div>
          </div>
          <pre className="nums mt-8 overflow-x-auto rounded-xl border border-line bg-panel p-5 text-xs leading-relaxed text-fg lg:mt-0">{`import { Tree, keys } from "torna-sdk";

const tree = new Tree(program, creator, askTreeId);
const key  = keys.orderKey(Side.Ask, price, slot, maker, nonce);

// the planner resolves the exact accounts off-chain
const ix = await tree.insertFastIx(reader, authority, key, value);

// node_idx / bump / path / spares: never your problem`}</pre>
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
