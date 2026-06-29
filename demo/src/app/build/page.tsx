import Link from "next/link";
import { ArrowRight, Boxes, Cpu, Gauge, Layers, ListOrdered, Trophy, Vote, Wallet } from "lucide-react";
import { GithubIcon } from "@/components/ui/GithubIcon";
import { CodeBlock as Code } from "@/components/ui/CodeBlock";

export const metadata = {
  title: "Build on Torna",
  description:
    "Why Solana developers use Torna, who it is for, and how to integrate it: a sorted, parallel on-chain index with a typed SDK and a CPI crate.",
};

const GH = "https://github.com/nzengi/torna";

const TOC: [string, string][] = [
  ["why", "Why Torna"],
  ["who", "Who it is for"],
  ["how", "How to integrate"],
  ["steps", "Four steps"],
  ["examples", "Model your domain"],
  ["compare", "vs roll-your-own"],
  ["cost", "Cost & limits"],
];

function H({ id, kicker, children }: { id: string; kicker?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24">
      {kicker && <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-brand">{kicker}</div>}
      <h2 className="display text-2xl font-semibold tracking-tight text-fg">{children}</h2>
    </div>
  );
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[15px] leading-relaxed text-muted">{children}</p>;
}

export default function BuildPage() {
  return (
    <div className="mx-auto max-w-6xl gap-12 px-6 py-12 lg:grid lg:grid-cols-[210px_1fr]">
      <aside className="hidden lg:block">
        <nav className="sticky top-24 space-y-0.5 text-sm">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">On this page</div>
          {TOC.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="block rounded px-2 py-1 text-muted transition-colors duration-100 hover:bg-panel-hi hover:text-fg">{label}</a>
          ))}
        </nav>
      </aside>

      <article className="min-w-0 max-w-3xl">
        <header className="border-b border-line pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">For developers</p>
          <h1 className="display mt-2 text-4xl font-semibold leading-tight tracking-tight">
            Build on <span className="text-gradient">Torna</span>
          </h1>
          <P>
            Ship sorted, parallel on-chain state without a slab allocator or an indexer. You bring a key
            and a value; the SDK resolves every account off-chain, or your program drives Torna over a CPI.
          </P>
          <div className="mt-5 flex flex-wrap items-center gap-2.5 text-sm">
            <code className="nums rounded-lg border border-line bg-panel px-3 py-1.5 text-fg">npm i torna-sdk</code>
            <Link href="/docs" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-1.5 font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi">Quickstart <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
            <a href={GH} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3.5 py-1.5 font-medium text-fg transition-colors duration-100 hover:border-muted"><GithubIcon className="h-3.5 w-3.5" /> GitHub</a>
          </div>
        </header>

        <div className="space-y-14 py-10">
          {/* WHY */}
          <section>
            <H id="why" kicker="Why">What you skip, what you get</H>
            <P>On-chain sorted state with many writers is the hard case on Solana. Torna is the part you would otherwise build yourself, and get subtly wrong.</P>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-ask/30 bg-ask/[0.05] p-4">
                <div className="text-sm font-semibold text-ask">You skip writing</div>
                <ul className="mt-2 space-y-1.5 text-sm text-muted">
                  <li>A slab allocator and account packing</li>
                  <li>An off-chain indexer to read state back</li>
                  <li>The single-account write-lock and the crank around it</li>
                  <li>PDA, bump, path, and split-spare bookkeeping</li>
                  <li>Your own B-tree rebalancing, with its own bugs</li>
                </ul>
              </div>
              <div className="rounded-xl border border-bid/30 bg-bid/[0.05] p-4">
                <div className="text-sm font-semibold text-bid">You get</div>
                <ul className="mt-2 space-y-1.5 text-sm text-muted">
                  <li>A sorted index that parallelizes (disjoint writes, same slot)</li>
                  <li>Off-chain reads with no transaction and no fee</li>
                  <li>A Rust and a TypeScript SDK that hide account resolution</li>
                  <li>A CPI crate to drive it from your own program</li>
                  <li>One audited primitive, not a per-project reimplementation</li>
                </ul>
              </div>
            </div>
          </section>

          {/* WHO */}
          <section>
            <H id="who" kicker="Who">Who it is for</H>
            <P>Any protocol with sorted state, concurrent writers, and on-chain queryability. If your design has one hot account everyone writes, Torna is the fix.</P>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                { icon: Gauge, t: "DEX and CLOB", d: "Price-time priority, parallel quotes, real escrow." },
                { icon: ListOrdered, t: "Lending and perps", d: "Liquidation queues sorted by health; keepers pop the worst." },
                { icon: Trophy, t: "Gaming and social", d: "Leaderboards and top-N with concurrent score updates." },
                { icon: Vote, t: "DAOs and governance", d: "Sorted stake or votes, queryable without an indexer." },
                { icon: Boxes, t: "Queues and schedulers", d: "Ordered by deadline; soonest expiry is the leftmost leaf." },
                { icon: Layers, t: "Any sorted index", d: "Generic key to value, value up to 128 bytes per tree." },
              ].map((c) => (
                <div key={c.t} className="flex gap-3 rounded-xl border border-line bg-panel p-3.5">
                  <c.icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                  <div><div className="text-sm font-semibold text-fg">{c.t}</div><p className="mt-0.5 text-[13px] leading-relaxed text-muted">{c.d}</p></div>
                </div>
              ))}
            </div>
            <P>It is the wrong tool for tiny datasets, data with no ordering, or workloads with no concurrent writers.</P>
          </section>

          {/* HOW */}
          <section>
            <H id="how" kicker="How">Two ways to integrate</H>
            <P>Pick by who owns the tree. Both use the same engine and the same off-chain reads.</P>

            <div className="mt-5 rounded-xl border border-line bg-panel p-4">
              <div className="text-sm font-semibold text-fg">Which SDK do I use? One, by your language.</div>
              <ul className="mt-2 space-y-1.5 text-[13px] text-muted">
                <li><span className="font-medium text-fg">A client, app, bot, or script:</span> torna-sdk, in TypeScript (npm) or Rust (crate). Pick one, your stack.</li>
                <li><span className="font-medium text-fg">An on-chain program:</span> torna-cpi (Rust), plus a client SDK for tests and scripts.</li>
                <li><span className="font-medium text-fg">A full dApp:</span> a Rust program (torna-cpi) and a TypeScript frontend (torna-sdk), the same split every Solana app has.</li>
              </ul>
              <p className="mt-2 text-[13px] text-faint">You never write C. That is the engine, already deployed and audited-in-house.</p>
            </div>

            <div className="mt-7 flex items-center gap-2">
              <Wallet className="h-4 w-4 text-brand" aria-hidden />
              <h3 className="text-sm font-semibold text-fg">A. Client-driven (off-chain)</h3>
            </div>
            <P>Your app or a keypair is the tree authority. The SDK reads the tree, builds the instruction with the exact accounts, and you sign and send. The simplest path.</P>
            <Code lang="typescript">{`import { Tree, keys } from "torna-sdk";

const tree = new Tree(program, creator, treeId);
const key  = keys.orderKey(keys.Side.Ask, price, slot, maker, nonce);

// the planner resolves the exact accounts off-chain
const ix = await tree.insertFastIx(reader, authority, key, value);
await sendAndConfirm(connection, new Transaction().add(ix), [signer]);`}</Code>

            <div className="mt-7 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-brand" aria-hidden />
              <h3 className="text-sm font-semibold text-fg">B. Program-driven (on-chain CPI)</h3>
            </div>
            <P>Your program owns the tree as a PDA authority and calls Torna over a CPI with the <span className="nums text-fg">torna-cpi</span> crate. This is how TornaDEX works: the book PDA is the authority, and place / cancel CPI into Torna while the program enforces escrow.</P>
            <Code lang="rust">{`use torna_cpi;

// your program signs as the tree authority PDA
let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];

torna_cpi::insert_fast(
    torna_program, authority_pda, header,
    path_accounts, &key, &value, &[seeds],
)?;`}</Code>
          </section>

          {/* STEPS */}
          <section>
            <H id="steps" kicker="Integrate">Four steps</H>
            <div className="mt-5 space-y-2.5">
              {[
                ["Install", "npm i torna-sdk @solana/web3.js for TypeScript, or cargo add torna-sdk solana-sdk for Rust (plus torna-cpi for an on-chain program)."],
                ["Create a tree once", "InitTree with a value_size (1 to 128 bytes) and a fanout (64 default). You get header + allocator PDAs, namespaced by your creator key."],
                ["Write on the hot path", "insertFastIx / updateFastIx / deleteFastIx: the header is read-only and only the leaf is writable, so disjoint-key writes from different payers commit in the same slot."],
                ["Read off-chain", "best, scan, get: the SDK walks the tree over RPC with no transaction. For a program, add the CPI from your handler and let Torna do the structure work."],
              ].map(([t, d], i) => (
                <div key={t} className="flex gap-3.5 rounded-xl border border-line bg-panel p-4">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-semibold text-brand">{i + 1}</div>
                  <div><div className="text-sm font-semibold text-fg">{t}</div><p className="mt-1 text-[13px] leading-relaxed text-muted">{d}</p></div>
                </div>
              ))}
            </div>
          </section>

          {/* EXAMPLES */}
          <section>
            <H id="examples" kicker="Model it">Your domain as a key</H>
            <P>The whole design is choosing what the 32-byte key and the value mean. Encode your sort field big-endian so byte order matches numeric order; add a writer-unique tail so two writers never collide.</P>
            <div className="mt-5 space-y-2.5">
              {[
                ["Liquidation queue", "key = health factor (big-endian), value = position id. Keepers read the leftmost (unhealthiest) leaf; borrowers update in parallel."],
                ["Leaderboard / top-N", "key = (MAX - score) big-endian so the best sorts first, value = player. Top-N is the first N entries; updates are concurrent."],
                ["Order book", "key = price | slot | maker | nonce, value = maker | size. Place is an insert, cancel a delete, a partial fill an update. This is TornaDEX."],
                ["Expiry queue", "key = deadline (big-endian), value = item id. The soonest to expire is always the leftmost leaf."],
              ].map(([t, d]) => (
                <div key={t} className="rounded-lg border-l-2 border-brand/50 bg-panel px-4 py-2.5">
                  <span className="text-sm font-semibold text-fg">{t}.</span> <span className="text-[13px] text-muted">{d}</span>
                </div>
              ))}
            </div>
            <Code lang="typescript">{`// a generic sorted key: your u64 sort field big-endian, then a
// writer-unique tail so ties never collide or serialize
const key = new Uint8Array(32);
new DataView(key.buffer).setBigUint64(0, sortField, false); // big-endian
key.set(writerId.subarray(0, 16), 16);

const ix = await tree.insertFastIx(reader, authority, key, value);`}</Code>
          </section>

          {/* COMPARE */}
          <section>
            <H id="compare" kicker="The math">vs roll-your-own</H>
            <div className="mt-5 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-panel-hi text-[11px] uppercase tracking-wide text-faint">
                    <th className="px-4 py-2 text-left font-medium"></th>
                    <th className="px-4 py-2 text-left font-medium">Hand-rolled</th>
                    <th className="px-4 py-2 text-left font-medium text-brand">Torna</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Sorting", "you write + debug", "B+ tree, built in"],
                    ["Parallel writes", "no, one lock", "yes, node per account"],
                    ["Read state back", "off-chain indexer", "SDK, free, no indexer"],
                    ["Accounts", "you manage them", "SDK hides them"],
                    ["Correctness", "your bugs", "reviewed primitive"],
                    ["Time to first write", "weeks", "an afternoon"],
                  ].map((r, i) => (
                    <tr key={r[0]} className={i % 2 ? "bg-bg-soft" : "bg-panel"}>
                      <td className="px-4 py-2.5 font-medium text-fg">{r[0]}</td>
                      <td className="px-4 py-2.5 text-muted">{r[1]}</td>
                      <td className="px-4 py-2.5 text-bid">{r[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* COST */}
          <section>
            <H id="cost" kicker="Plan for it">Cost and limits</H>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-panel p-4">
                <div className="text-sm font-semibold text-fg">What it costs</div>
                <ul className="mt-2 space-y-1.5 text-[13px] text-muted">
                  <li>Standing up a tree: ~<span className="nums text-fg">0.003 SOL</span> (refundable).</li>
                  <li>A resting entry: ~<span className="nums text-fg">0.0005 SOL</span> amortized at fanout 64.</li>
                  <li>Per write: just the ~5000-lamport network fee.</li>
                  <li>Reads: free, they are off-chain.</li>
                </ul>
              </div>
              <div className="rounded-xl border border-line bg-panel p-4">
                <div className="text-sm font-semibold text-fg">Design around</div>
                <ul className="mt-2 space-y-1.5 text-[13px] text-muted">
                  <li>Each parallel writer funds with its own fee-payer.</li>
                  <li>Keys are 32 bytes, big-endian; values 1 to 128 bytes.</li>
                  <li>A serial consumer (top-of-book matching) stays serial.</li>
                  <li>Adversarial-reviewed; external audit pending, devnet only.</li>
                </ul>
              </div>
            </div>
          </section>

          {/* CTA */}
          <section className="glass neon-glow relative overflow-hidden rounded-2xl px-6 py-8">
            <div className="brand-gradient pointer-events-none absolute -right-20 -top-20 h-52 w-52 rounded-full opacity-25 blur-3xl" aria-hidden />
            <h2 className="display relative text-xl font-semibold tracking-tight text-fg sm:text-2xl">Start with a key and a value</h2>
            <p className="relative mt-2 text-sm leading-relaxed text-muted">The SDK is on npm and crates.io, and the engine is live on devnet.</p>
            <div className="relative mt-5 flex flex-wrap items-center gap-2.5 text-sm">
              <Link href="/docs" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi">Read the docs <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
              <Link href="/trade" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 font-medium text-fg transition-colors duration-100 hover:bg-panel-hi">See TornaDEX live</Link>
            </div>
          </section>
        </div>
      </article>
    </div>
  );
}
