import { BTree } from "@/components/diagrams/BTree";
import { OrderKey } from "@/components/diagrams/OrderKey";
import { Throughput } from "@/components/diagrams/Throughput";
import { Compare } from "@/components/Compare";
import { MARKET, explorerTx } from "@/lib/market";
import tx from "@/lib/sample-tx.json";

export const metadata = {
  title: "Research · Torna",
  description:
    "A research writeup of Torna: motivation, existing on-chain order-book designs and their bottlenecks, the three scarce resources, the design space explored, the Torna design, de-risking spikes, evaluation, and open problems.",
};

const TOC: [string, string][] = [
  ["abstract", "Abstract"],
  ["motivation", "1. Motivation"],
  ["prior", "2. Existing approaches"],
  ["problem", "3. The three constraints"],
  ["space", "4. Design space explored"],
  ["design", "5. The Torna design"],
  ["spikes", "6. De-risking spikes"],
  ["eval", "7. Evaluation"],
  ["discussion", "8. Discussion & limits"],
  ["conclusion", "9. Conclusion"],
  ["refs", "Artifacts"],
];

function H({ id, n, children }: { id: string; n?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="display scroll-mt-24 text-2xl font-semibold tracking-tight text-fg">
      {n && <span className="text-faint">{n} </span>}{children}
    </h2>
  );
}
function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`mt-3 text-[15px] leading-[1.75] text-muted ${className}`}>{children}</p>;
}
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-serial/40 bg-serial/[0.06] px-4 py-3 text-sm leading-relaxed text-muted">
      <span className="font-semibold text-serial">Honest note. </span>{children}
    </div>
  );
}

const PRIOR: [string, string, string][] = [
  ["Slab CLOB (Serum / OpenBook v1)", "As publicly described: the book lives in a few large per-market accounts (bid and ask slabs plus request and event queues), each a single write lock; a permissionless crank drains the event queue to settle and credit fills.", "Every order on a side contends on that side's one writable slab, so placements serialize, and the event-queue plus crank model adds latency and a liveness dependency."],
  ["Crankless CLOB (Phoenix-style)", "Removes the crank by matching atomically inside the taker's transaction, with no event queue.", "The market state is still concentrated in one account, so order operations on it take the same write lock and serialize."],
  ["Off-chain book + on-chain settle", "The order book lives on a relayer; only settlement is on-chain.", "Not actually on-chain: trust, liveness, and censorship move off-chain, and the book is not composable from other programs."],
  ["AMM (constant-product)", "Sidesteps the order book entirely with a pool curve.", "No limit orders and no price-time priority; capital inefficiency and impermanent loss; a different product, not an order book."],
  ["Naive on-chain B-tree", "A textbook B-tree, either in one account or with low fanout across accounts.", "One account reintroduces the slab's serial write lock; low fanout makes the tree tall, so a single operation touches too many node accounts and blows the per-transaction account budget."],
];

const SPACE: [string, string, string][] = [
  ["Single-account slab", "rejected", "Loses all three constraints: one write lock (no parallelism), one account (size + rent ceiling)."],
  ["Low-fanout B-tree, node per account", "rejected", "Height grows, so an operation touches many node accounts and exceeds the account budget."],
  ["Skip list, node per account", "rejected", "Probabilistic height and pointer-chasing; parallelism is hard to reason about and tail latency is unbounded."],
  ["Hash index", "rejected", "O(1) point access but no ordering, so no best-price, no range scan, no book."],
  ["LSM / append log", "rejected", "Write-amortized but needs compaction and gives no in-place sorted reads; ordering is rebuilt off-chain."],
  ["High-fanout B+ tree, node per account", "chosen", "Near-optimal on all three: height ~3 (account budget), one node per account (parallelism), fanout amortizes per-account rent."],
];

const BENCH: [string, string, string, string][] = [
  ["A  disjoint leaves (parallel)", "28,725", "13,399", "10,614"],
  ["B  same leaf (serial)", "29,852", "3,927", "1,749"],
  ["C  same fee-payer (serial)", "6,246", "2,278", "1,237"],
];
const CU: [string, string][] = [
  ["InsertFast, hot path (F = 16 / 64 / 128)", "8k / 23k / 43k"],
  ["Insert with split + root-grow (F = 64 / 128)", "38k / 68k"],
  ["Delete with merge + collapse", "50k"],
  ["MultiLeafInsertFast (8 x 12)", "204k"],
  ["BulkInsertFast (32 front-insert, worst case)", "400k"],
];

export default function ResearchPage() {
  return (
    <div className="mx-auto max-w-6xl gap-12 px-6 py-12 lg:grid lg:grid-cols-[210px_1fr]">
      <aside className="hidden lg:block">
        <nav className="sticky top-24 space-y-0.5 text-sm">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Contents</div>
          {TOC.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="block rounded px-2 py-1 text-muted transition-colors duration-100 hover:bg-panel-hi hover:text-fg">{label}</a>
          ))}
        </nav>
      </aside>

      <article className="min-w-0 max-w-3xl">
        <header className="border-b border-line pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Research</p>
          <h1 className="display mt-2 text-4xl font-semibold leading-tight tracking-tight">
            Torna: a parallel, ordered <span className="text-gradient">index primitive</span> for Solana
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            Motivation, prior designs and their bottlenecks, the constraints that bound the problem, the
            design space we explored, the Torna design, how we de-risked it, what we measured, and what
            remains open. Every number here is reproducible from the repository.
          </p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
            <a className="hover:text-brand" href="https://github.com/nzengi/torna" target="_blank" rel="noreferrer">GitHub</a>
            <a className="hover:text-brand" href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer">torna-sdk on npm</a>
            <a className="hover:text-brand" href="/trade">Live demo</a>
            <a className="hover:text-brand" href={explorerTx(tx.signature)} target="_blank" rel="noreferrer">A captured transaction</a>
          </div>
        </header>

        <div className="space-y-14 py-10">
          {/* ABSTRACT */}
          <section>
            <H id="abstract">Abstract</H>
            <P>
              Torna is a parallel, ordered, on-chain index primitive for Solana. It stores a sorted key to
              value map as a high-fanout B+ tree with one node per account, so writes at different keys
              carry disjoint write sets and the Sealevel scheduler commits them in the same slot. The
              central limit order book is the hardest instance of the general problem (sorted state with
              many concurrent writers), and the dominant Solana designs answer it by concentrating the
              book in a single large account (often, though not always, with an off-chain crank), which
              serializes writes and, where a crank is used, adds a liveness dependency. We
              formalize the three scarce resources that bound any design, walk the design space we
              explored and rejected, present Torna, and evaluate it: a measured 3.4 to 6x throughput gain
              for disjoint versus contended writes on a real validator banking stage, single-key hot
              operations under the 200k compute-unit default even at fanout 128, and a correctness regimen
              of an 8,000-operation on-chain differential, 60k-iteration fuzzing, and five rounds of
              adversarial review to convergence with token-conservation invariants on the reference order
              book. We close with limitations and open problems, including that matching itself stays
              serial and that an external audit is still pending.
            </P>
          </section>

          {/* MOTIVATION */}
          <section>
            <H id="motivation" n="1.">Motivation</H>
            <P>
              A great deal of on-chain logic needs the same two things at once: keep state sorted, and let
              many independent actors write to it concurrently. An order book keeps orders sorted by
              price-time and is updated by many makers; a liquidation engine keeps positions sorted by
              health and is updated by many borrowers; a leaderboard keeps scores sorted and is updated by
              many players. The order book is the sharpest version of this problem because it combines a
              strict global sort, a high write rate from independent parties, and real custody of funds.
            </P>
            <P>
              Solana is the natural home for this: its parallel runtime (Sealevel) can execute transactions
              that touch disjoint accounts in the same slot. But that parallelism is only available to a
              data structure laid out so that independent writes land on different accounts. The order
              books shipped on Solana to date are not laid out that way, and as a result they leave most of
              the runtime&apos;s parallelism on the table. Torna is an attempt to recover it as a reusable
              primitive, rather than once per application.
            </P>
          </section>

          {/* PRIOR */}
          <section>
            <H id="prior" n="2.">Existing approaches and their bottlenecks</H>
            <P>
              The on-chain order book has been attempted several ways. Each makes a different tradeoff, and
              each has a bottleneck that Torna is designed to remove. We describe them at a high level as a
              design family, not as a critique of any specific implementation; details vary by version and
              by team.
            </P>
            <div className="mt-5 space-y-3">
              {PRIOR.map((r) => (
                <div key={r[0]} className="rounded-xl border border-line bg-panel p-4">
                  <div className="text-sm font-semibold text-fg">{r[0]}</div>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{r[1]}</p>
                  <p className="mt-2 text-sm leading-relaxed"><span className="font-medium text-ask">Bottleneck. </span><span className="text-muted">{r[2]}</span></p>
                </div>
              ))}
            </div>
            <P>
              The common thread in the on-chain designs is a single large account holding the whole book.
              That choice makes the data structure simple, but it forces every write through one account
              lock, which is exactly the resource Solana parallelizes on. The off-chain and AMM designs
              avoid the lock by giving up the property we want: a real, composable, on-chain limit order
              book.
            </P>
          </section>

          {/* PROBLEM */}
          <section>
            <H id="problem" n="3.">The three constraints</H>
            <P>
              Any on-chain sorted structure on Solana is bound by three scarce resources. Stating them
              explicitly is what makes the design choice forced rather than aesthetic.
            </P>
            <ol className="mt-4 space-y-3 text-[15px] text-muted">
              <li>
                <span className="font-medium text-fg">i. Per-transaction account budget.</span> A
                transaction can reference a limited number of accounts (about 35 in a legacy transaction,
                about 256 with address lookup tables). This is the scarcest resource: it caps how many node
                accounts a single operation may touch, and therefore the height of any account-per-node
                tree.
              </li>
              <li>
                <span className="font-medium text-fg">ii. Account-lock parallelism (Sealevel).</span> Two
                transactions run in the same slot only if their writable account sets are disjoint. A data
                structure parallelizes exactly to the extent that independent logical writes touch
                different accounts.
              </li>
              <li>
                <span className="font-medium text-fg">iii. Rent.</span> Every account carries a
                rent-exempt deposit with a fixed per-account overhead. A design with many tiny accounts
                pays that overhead repeatedly; the structure must amortize it.
              </li>
            </ol>
            <P>
              For a single-account slab, (i) is fine, but (ii) is zero (one lock) and (iii) hits the
              account size ceiling. A textbook low-fanout B-tree spread across accounts wins (ii) and (iii)
              but loses (i), because its height makes one operation touch too many accounts. The design has
              to win all three at once.
            </P>
          </section>

          {/* SPACE */}
          <section>
            <H id="space" n="4.">Design space explored</H>
            <P>
              We evaluated the obvious candidates against the three constraints before committing. The
              table records what we rejected and why; the rejections are as informative as the choice.
            </P>
            <div className="mt-5 overflow-hidden rounded-xl border border-line text-sm">
              <div className="grid grid-cols-[1.4fr_auto_2fr] gap-3 bg-panel-hi px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
                <span>candidate</span><span>verdict</span><span>reason</span>
              </div>
              {SPACE.map((r, i) => (
                <div key={r[0]} className={`grid grid-cols-[1.4fr_auto_2fr] items-start gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                  <span className="font-medium text-fg">{r[0]}</span>
                  <span className={`text-[11px] font-semibold uppercase ${r[1] === "chosen" ? "text-bid" : "text-ask"}`}>{r[1]}</span>
                  <span className="text-muted">{r[2]}</span>
                </div>
              ))}
            </div>
            <P>
              The high-fanout B+ tree with one node per account is near-optimal on all three. With the
              default fanout of 64 the tree is about three levels deep, so an operation touches roughly
              three node accounts; each node is its own account, so disjoint-key writes never share a lock;
              and the fanout amortizes the per-account overhead across many entries. The reason the
              structure is a B+ tree and not a slab or a skip list is precisely this three-way fit.
            </P>
          </section>

          {/* DESIGN */}
          <section>
            <H id="design" n="5.">The Torna design</H>
            <P>
              Torna stores a sorted, opaque key to value map. Keys are 32 bytes compared
              byte-lexicographically; values are inline, of a width fixed per tree between 1 and 128 bytes.
              The structure is a high-fanout B+ tree, and each node lives in its own program-derived
              account.
            </P>
            <div className="mt-5 rounded-xl border border-line bg-panel p-5"><BTree /></div>

            <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-brand">Hot path and cold path</h3>
            <P>
              The key idea is that the common operations never write the shared header. On the hot path
              (insert into a non-full leaf, update a value in place, delete without rebalancing, point and
              range reads), the header is read-only and only the target leaf is writable, with no
              cross-program calls. Two writers landing in different leaves therefore have disjoint writable
              sets and commit together. The cold path (an insert that splits a full leaf, or a delete that
              merges an underfull one) is the only place that allocates or frees node accounts; it touches
              a separate allocator account and calls the system program. Mutable counters such as the next
              node index live in that allocator, not the header, so plain inserts never take a write lock
              on the header. Keepers run compaction off-peak to keep the hot path split-free.
            </P>

            <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-brand">Tenant binding</h3>
            <P>
              One audited program serves many independent trees. Accounts are namespaced by the creator&apos;s
              public key, and every node and header carries a 128-bit{" "}
              <span className="nums text-fg">tree_uid = sha256(creator || tree_id)[..16]</span> that is
              checked at every node-validation site. This matters because the client-chosen tree id and the
              per-tree node index both collide across creators; only the creator-derived uid is a real
              tenant boundary. An earlier 8-byte binding was widened to 16 bytes during review because 8
              bytes was grindable. This is the kind of correctness property that random differential and
              fuzz testing did not catch, because they shared the author&apos;s blind spots, and that
              adversarial review did.
            </P>

            <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-brand">The book is the key</h3>
            <P>
              For the order-book instantiation, one 32-byte key encodes price-time priority directly, so
              the tree is the sorted book with no secondary index. The price occupies the high bytes
              big-endian so byte order matches numeric order; a writer-unique tail (maker and nonce)
              breaks ties so two makers at the same price are vanishingly unlikely to collide, and do not serialize on each other.
            </P>
            <div className="mt-5"><OrderKey /></div>

            <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-brand">The client is the product</h3>
            <P>
              The engine is roughly a fifth of the value; the rest is a client that makes account
              resolution invisible. The developer calls with a key and a value, and the SDK reads the tree
              off-chain and returns the exact account set, so node indices, PDA bumps, the descent path,
              and split spares never appear in application code. A Rust and a TypeScript SDK are
              byte-equivalent, and an integrating program can drive Torna over a cross-program call as its
              own PDA, which a probe program confirms preserves parallelism.
            </P>
          </section>

          {/* SPIKES */}
          <section>
            <H id="spikes" n="6.">De-risking spikes</H>
            <P>
              Before building the engine we ran isolated spikes to retire the load-bearing unknowns, so
              that the design rested on measurements rather than hope.
            </P>
            <ul className="mt-4 space-y-2 text-[15px] text-muted">
              <li><span className="font-medium text-fg">Does fanout bind on compute?</span> A leaf-engine CU sweep showed even a fanout-128 worst-case insert costs about 27k CU, far under the budget, so compute does not bind fanout. The binding resource is the account budget, which is what sets fanout to 64 by default and 128 for large trees.</li>
              <li><span className="font-medium text-fg">Does the runtime actually parallelize this?</span> A saturation benchmark on a real single-node validator, not a simulator, confirmed that disjoint-leaf writes commit several times more transactions per slot than contended ones (Section 7).</li>
              <li><span className="font-medium text-fg">Does composability survive a CPI?</span> A caller program that drives InsertFast as a PDA authority kept the parallel property, so an integrating program loses nothing.</li>
              <li><span className="font-medium text-fg">What is the read and return-data envelope?</span> Spikes pinned the 1,024-byte return-data ceiling and the cost of emitting it, which shaped the read instructions.</li>
            </ul>
            <P>
              The single most consequential finding was the fee-payer trap: two transactions from the same
              payer serialize even on different leaves, because the fee debit makes the payer a writable
              account. This is why the SDK and the demo fund each parallel writer with its own payer, and
              why the benchmark isolates it as a distinct workload.
            </P>
          </section>

          {/* EVAL */}
          <section>
            <H id="eval" n="7.">Evaluation</H>

            <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-brand">7.1 A throughput model</h3>
            <P>
              Model the writable lock set of a maintenance transaction as the pair{" "}
              <span className="nums text-fg">{"{leaf(k), payer(w)}"}</span>: the leaf the key k lands in and
              the writer&apos;s fee-payer. Two transactions conflict, and cannot share a slot, exactly when
              they share a leaf or share a payer. Each slot the banking stage commits a maximal set of
              mutually non-conflicting transactions across its W lanes.
            </P>
            <P>
              For N pending writes spread over L leaves and P payers, the committed count per slot is
              approximately the expression below, where S is the slot time and t the per-transaction
              execution time. The speedup over the fully serial case, one account and one lock, is the
              factor in front.
            </P>
            <div className="my-4 space-y-2">
              <div className="nums rounded-lg border border-line bg-panel px-4 py-3 text-center text-[15px] text-fg">committed / slot  ≈  min(W, L, P) · (S / t)</div>
              <div className="nums rounded-lg border border-line bg-panel px-4 py-3 text-center text-[15px] text-fg">σ  =  min(W, L, P)</div>
            </div>
            <P>
              Three regimes follow directly. Disjoint writes (different leaf, different payer) give{" "}
              <span className="nums text-fg">σ = min(W, L, P)</span>, bounded by the hardware lane count. A
              shared leaf collapses σ to 1, and so does a shared payer, the fee-payer trap. The B+ tree
              supplies L: a book of n resting orders at fanout F occupies about n/F leaves, so L grows with
              depth and the binding term is the lane count W until the book is shallow.
            </P>
            <P>
              Matching is serial and cannot be parallelized. Let α be the matching fraction of traffic and
              1 minus α the maintenance fraction. The aggregate speedup is then the Amdahl form below: it
              approaches σ for a maker-heavy book and falls to 1 as traffic becomes taker-heavy.
            </P>
            <div className="my-4 nums rounded-lg border border-line bg-panel px-4 py-3 text-center text-[15px] text-fg">σ_agg  =  1 / ( α + (1 - α) / σ )</div>
            <figure className="mt-6">
              <div className="rounded-xl border border-line bg-panel p-5"><Throughput /></div>
              <figcaption className="mt-2 text-xs leading-relaxed text-faint">
                Figure 1. Aggregate speedup as a function of how maker-heavy the book is, for the measured
                disjoint-write ceiling σ = 3.4 (peak slot) to 6 (median busy slot). A liquid book sits to the right, where the
                aggregate win is close to σ; a taker-heavy book sits to the left, where it approaches 1.
              </figcaption>
            </figure>

            <h3 className="mt-10 text-sm font-semibold uppercase tracking-wide text-brand">7.2 Measured</h3>
            <P>
              <span className="font-medium text-fg">Parallelism.</span> The model predicts σ = min(W, L, P).
              On a real single-node validator banking stage, with identical compute per transaction so the
              only variable is the writable lock set, we measure committed transactions per roughly 400ms
              slot under saturation across three workloads: disjoint leaves with disjoint payers (parallel),
              the same leaf (serial), and the same fee-payer (serial). The lane count W of a single node is
              small, so we expect a few-fold σ, with L and P large.
            </P>
            <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
              <div className="grid grid-cols-[1.7fr_1fr_1fr_1fr] gap-3 bg-panel-hi px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
                <span>workload</span><span className="text-right">confirmed</span><span className="text-right">peak/slot</span><span className="text-right">p50 busy</span>
              </div>
              {BENCH.map((r, i) => (
                <div key={r[0]} className={`grid grid-cols-[1.7fr_1fr_1fr_1fr] gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                  <span className={`font-medium ${i === 0 ? "text-bid" : "text-fg"}`}>{r[0]}</span>
                  <span className="nums text-right text-muted">{r[1]}</span>
                  <span className="nums text-right text-fg">{r[2]}</span>
                  <span className="nums text-right text-fg">{r[3]}</span>
                </div>
              ))}
            </div>
            <P>
              Disjoint writes commit about 3.4x (peak) to 6x (median busy slot) more transactions per slot
              than same-leaf writes, and about 5.9x to 8.6x more than same fee-payer. A single-node
              validator has a small fixed number of banking threads, so a real cluster would widen the
              ratio, not narrow it.
            </P>
            <Note>
              This measures book maintenance, the maker side, not matching. Top-of-book matching is
              price-time serial by definition and nothing parallelizes it. The claim is that maker traffic
              dominates a liquid book, so parallelizing it dominates aggregate throughput, not that the
              match itself is parallel.
            </Note>

            <P className="mt-8">
              <span className="font-medium text-fg">Compute.</span> Measured on the real engine, single-key
              hot operations stay under the 200k default budget even at fanout 128; the batch operations
              request a higher limit and remain far below the per-transaction cap.
            </P>
            <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
              {CU.map((r, i) => (
                <div key={r[0]} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                  <span className="text-muted">{r[0]}</span><span className="nums font-medium text-fg">{r[1]}</span>
                </div>
              ))}
            </div>
            <P>
              For a concrete end-to-end figure, an actual order placement captured on devnet cost{" "}
              <span className="nums text-fg">{tx.compute_units_consumed?.toLocaleString()}</span> compute
              units total, of which the inner engine InsertFast was roughly 3k, with a 5000-lamport fee.
            </P>

            <P className="mt-8">
              <span className="font-medium text-fg">Correctness and security.</span> The engine is exercised
              by an on-chain differential of 8,000 randomized operations against an independent oracle, a
              60k-iteration fuzzer with zero memory violations, and a host-side property suite. The
              reference order book is checked by a token-conservation invariant after every operation. Most
              important, each layer went through adversarial review to convergence (rounds until two
              consecutive clean passes): the engine took five rounds plus a class audit, during which a
              single class of bug, treating program-owned as tenant-owned, recurred four times across nodes,
              the allocator, scratch, and delegates, until a systematic sweep closed the class. The order
              book took five rounds, the headline being a forged-tree settlement that drained the real
              vault at near-zero cost, fixed by binding the book to its market config before any token
              moves.
            </P>

            <P className="mt-8">
              <span className="font-medium text-fg">Economics.</span> Rent is a refundable deposit, not a
              fee, and is reclaimed when an account is closed. An empty tree is about 0.003 SOL; a full
              market is about 0.024 SOL; a resting entry is a slot in an existing leaf, so its marginal
              rent is the leaf rent amortized over the fanout, roughly 0.0005 SOL at fanout 64, reclaimed on
              merge. The recurring per-transaction cost is just the network fee; new node accounts are
              created only on a split.
            </P>
          </section>

          {/* DISCUSSION */}
          <section>
            <H id="discussion" n="8.">Discussion, limitations, and open problems</H>
            <P>
              <span className="font-medium text-fg">Matching stays serial.</span> Torna parallelizes the
              maker side. Top-of-book consumption is a single contention point and cannot be parallelized;
              this is a property of price-time priority, not of the data structure. The bet is that liquid
              books are maker-heavy.
            </P>
            <P>
              <span className="font-medium text-fg">The fee-payer is a lock.</span> Independent writers must
              use independent payers, or they serialize on the fee debit. The SDK surfaces this; it is a
              constraint integrators must respect.
            </P>
            <P>
              <span className="font-medium text-fg">Time priority is slot-granular and tiebreaks are
              client-supplied.</span> A strict global FIFO counter would serialize every placement, so it is
              deliberately not used; uniqueness lives in a writer-chosen tail and time priority is
              approximate at slot granularity.
            </P>
            <P>
              <span className="font-medium text-fg">Trust and audit.</span> The in-house adversarial review
              is not an external audit, which is pending. The single largest open trust decision is the
              upgrade-authority policy: make the program immutable after audit, or hold the authority under
              a timelocked multisig. It is not yet decided, and it is the main assumption an integrator
              inherits.
            </P>
            <P>
              <span className="font-medium text-fg">Future work.</span> A multi-node devnet benchmark would
              produce a stronger throughput number than the single-node figure here; cascade-aware keeper
              compaction would tighten the cold-path edge cases; and the external audit is the gate to any
              mainnet use.
            </P>
            <div className="mt-6"><Compare /></div>
          </section>

          {/* CONCLUSION */}
          <section>
            <H id="conclusion" n="9.">Conclusion</H>
            <P>
              The on-chain order book has been treated as an application to be hand-built, and each attempt
              has paid the single-account serialization tax or stepped off-chain to avoid it. We argue it is
              better treated as one instance of a primitive: sorted state with concurrent writers, laid out
              so the runtime can parallelize it. Torna is that primitive, a high-fanout B+ tree with one
              node per account, a hot path that never locks the header, a tenant binding that survived
              adversarial review, and a client that hides account resolution entirely. The reference order
              book, TornaDEX, is the proof that it works end to end on devnet today. The contribution is not
              the B+ tree, which is textbook; it is the layout chosen against Solana&apos;s three
              constraints, the correctness work behind it, and the SDK that makes it usable, packaged as a
              primitive others can build on rather than rebuild.
            </P>
          </section>

          {/* REFS */}
          <section>
            <H id="refs">Artifacts</H>
            <P>Everything above is reproducible and live.</P>
            <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              {[
                ["Source (engine, SDKs, orderbook, benchmark)", "https://github.com/nzengi/torna"],
                ["torna-sdk on npm", "https://www.npmjs.com/package/torna-sdk"],
                ["Live demo (TornaDEX on devnet)", "/trade"],
                ["On-chain explorer", "/explorer"],
                ["Engine program on Solana Explorer", `https://explorer.solana.com/address/${MARKET.tornaProgramId}?cluster=devnet`],
                ["A captured PlaceOrder transaction", explorerTx(tx.signature)],
              ].map(([label, href]) => (
                <a key={label} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="rounded-lg border border-line bg-panel px-4 py-2.5 text-muted transition-colors duration-100 hover:border-brand/40 hover:text-fg">
                  {label}
                </a>
              ))}
            </div>
            <p className="mt-6 text-xs leading-relaxed text-faint">
              Numbers in this document: parallelism and compute are measured on a single-node
              solana-test-validator banking stage and the real engine; correctness figures are the current
              passing test counts; rent is measured on devnet. Devnet is shared and noisy, so the
              controlled single-node numbers are the honest ones. In-house adversarial review is not an
              external audit.
            </p>
          </section>
        </div>
      </article>
    </div>
  );
}
