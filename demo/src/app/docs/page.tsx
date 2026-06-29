import { BTree } from "@/components/diagrams/BTree";
import { OrderKey } from "@/components/diagrams/OrderKey";
import { Compare } from "@/components/Compare";
import { Address } from "@/components/ui/Address";
import { MARKET, explorerTx } from "@/lib/market";
import tx from "@/lib/sample-tx.json";

export const metadata = { title: "Docs · TornaDEX" };

const TOC: [string, string][] = [
  ["overview", "Overview"],
  ["live", "Live on devnet"],
  ["stack", "The stack"],
  ["resources", "Three scarce resources"],
  ["node", "One node per account"],
  ["instructions", "Instruction set"],
  ["abi", "On-chain layout (ABI)"],
  ["key", "The order key"],
  ["sdk", "The SDK"],
  ["performance", "Performance"],
  ["security", "Security & testing"],
  ["compare", "Slab vs Torna"],
  ["usecases", "Use cases"],
  ["roadmap", "Roadmap"],
];

function H({ id, kicker, children }: { id: string; kicker?: string; children: React.ReactNode }) {
  return (
    <div className="scroll-mt-24" id={id}>
      {kicker && <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-brand">{kicker}</div>}
      <h2 className="display text-2xl font-semibold tracking-tight text-fg">{children}</h2>
    </div>
  );
}
function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`mt-3 text-[15px] leading-relaxed text-muted ${className}`}>{children}</p>;
}
function Code({ children }: { children: string }) {
  return <pre className="nums mt-4 overflow-x-auto rounded-lg border border-line bg-panel p-4 text-xs leading-relaxed text-fg">{children}</pre>;
}
function Tag({ kind }: { kind: "hot" | "cold" | "read" | "admin" }) {
  const c = kind === "hot" ? "text-bid" : kind === "cold" ? "text-ask" : kind === "read" ? "text-parallel" : "text-faint";
  return <span className={`text-[11px] font-semibold uppercase ${c}`}>{kind}</span>;
}
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-serial/40 bg-serial/[0.06] px-4 py-3 text-sm leading-relaxed text-muted">
      <span className="font-semibold text-serial">Honest note. </span>{children}
    </div>
  );
}

// --- data (provenance: torna_docs + on-chain capture) ---
const INSTRUCTIONS: [number, string, string, "hot" | "cold" | "read" | "admin"][] = [
  [0, "InitTree", "Create header + allocator PDAs for a new tree", "admin"],
  [2, "Insert", "Cold insert: descend, split via CPI-created spares, grow root", "cold"],
  [3, "Find", "Point lookup, returns [found, value] via return_data", "read"],
  [4, "RangeScan", "Forward/reverse scan into a caller scratch account", "read"],
  [5, "Stats", "Return the tree header via return_data", "read"],
  [6, "CompactLeaf", "Keeper: reclaim an empty leftmost leaf (rent to payer)", "cold"],
  [8, "Delete", "Cold delete: bottom-up borrow/merge, CPI close, root collapse", "cold"],
  [9, "BulkInsertFast", "Insert a batch of keys into one leaf", "hot"],
  [11, "TransferAuthority", "Rotate the tree's authority (resets delegates)", "admin"],
  [12, "AddDelegate", "Add a delegate signer (primary-only)", "admin"],
  [13, "RemoveDelegate", "Remove a delegate (primary-only)", "admin"],
  [14, "MultiLeafInsertFast", "Atomic insert across several leaves in one tx", "hot"],
  [16, "InsertFast", "Insert one key/value into an existing leaf", "hot"],
  [17, "UpdateFast", "Overwrite the value at an existing key in place", "hot"],
  [18, "DeleteFast", "Remove a key without rebalancing", "hot"],
];

const BENCH: [string, string, string, string][] = [
  ["A  disjoint leaves", "28,725", "13,399", "10,614"],
  ["B  same leaf", "29,852", "3,927", "1,749"],
  ["C  same fee-payer", "6,246", "2,278", "1,237"],
];

const CU: [string, string][] = [
  ["InsertFast (F = 16 / 64 / 128)", "8k / 23k / 43k"],
  ["Insert + split + root-grow (F = 64 / 128)", "38k / 68k"],
  ["Delete + merge + collapse", "50k"],
  ["MultiLeafInsertFast (8 x 12)", "204k"],
  ["BulkInsertFast (32 front-insert, worst case)", "400k"],
];

export default function DocsPage() {
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

      <article className="min-w-0 max-w-3xl space-y-16">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Documentation</p>
          <h1 className="display mt-2 text-4xl font-semibold tracking-tight">
            Torna, <span className="text-gradient">explained in full</span>
          </h1>
          <P>
            Torna is the first parallel, ordered, on-chain index primitive for Solana: a sorted
            key to value store where every B+ tree node lives in its own account, so writes at
            different keys carry disjoint write sets and the Sealevel scheduler runs them in the same
            slot. It is a generic sorted index, not a matching engine. The engine is written in C for
            SBF; TornaDEX is the reference order book built on it. Everything below is live on devnet
            and reproducible.
          </P>
          <Note>
            Torna parallelizes book <span className="text-fg">maintenance</span> (maker place and
            cancel across prices), not matching. Top-of-book matching is price-time serial and nothing
            can change that. The numbers on this page are measured on a single-node validator banking
            stage; devnet is shared, so the controlled number is the honest one. In-house adversarial
            review is not an external audit, which is still pending.
          </Note>
        </header>

        {/* OVERVIEW */}
        <section>
          <H id="overview" kicker="The idea">A sorted index, without the slab</H>
          <P>
            An order book needs two things at once: keep orders sorted (best price first) and let many
            traders update it concurrently. On Solana both are hard. The usual answer is a single giant
            slab account plus an off-chain indexer to read it back. Torna replaces both: sorting comes
            from a B+ tree, parallelism comes from putting one node in each account, and the client SDK
            resolves the exact accounts off-chain so node indices, bumps, paths, and split spares never
            reach the developer.
          </P>
          <P>
            The moat is not the algorithm, anyone can write a B-tree. It is the three-constraint design
            below plus a typed client that makes account resolution invisible, and being the
            canonical, audited primitive.
          </P>
        </section>

        {/* LIVE */}
        <section>
          <H id="live" kicker="Proof">Live on devnet, with a real transaction</H>
          <P>Both programs are deployed and a market is initialized and seeded. Every address opens on the Solana Explorer.</P>
          <div className="mt-4 divide-y divide-line/60 rounded-xl border border-line bg-panel px-4">
            {[
              ["Torna engine program", MARKET.tornaProgramId],
              ["Orderbook program", MARKET.orderbookProgramId],
              ["Market config (cfg)", MARKET.cfg],
              ["Book authority (PDA)", MARKET.book],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between py-2.5 text-sm">
                <span className="text-muted">{k}</span><Address value={v} />
              </div>
            ))}
          </div>

          <P>
            Here is an actual <span className="text-fg">PlaceOrder</span> transaction captured from
            devnet. The orderbook program escrows tokens via an SPL-Token CPI, then CPIs the Torna
            engine&apos;s InsertFast to insert the order into the on-chain B+ tree, atomically in one
            transaction.
          </P>
          <div className="mt-4 glass rounded-xl p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                ["compute units", tx.compute_units_consumed?.toLocaleString() ?? "-"],
                ["fee (lamports)", tx.fee_lamports.toLocaleString()],
                ["accounts", String(tx.accounts.length)],
                ["status", tx.status],
              ].map(([k, v]) => (
                <div key={k}><div className="text-[11px] uppercase tracking-wide text-faint">{k}</div><div className="nums text-lg font-semibold text-fg">{v}</div></div>
              ))}
            </div>
            <div className="mt-4 text-[11px] uppercase tracking-wide text-faint">program log (CPI evidence)</div>
            <pre className="nums mt-1.5 overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 text-[11px] leading-relaxed text-muted">{tx.program_log.join("\n")}</pre>
            <a href={explorerTx(tx.signature)} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-brand hover:text-brand-hi">View this transaction on the Solana Explorer</a>
          </div>
          <P>
            The inner <span className="nums text-fg">Program {MARKET.tornaProgramId.slice(0, 4)}... invoke [2]</span> line
            is the engine running InsertFast as a CPI from the book authority PDA, consuming roughly 3k
            compute units; the whole place costs ~11k CU and a 5000-lamport fee.
          </P>
        </section>

        {/* STACK */}
        <section>
          <H id="stack" kicker="Architecture">Core, plus what is built on it</H>
          <P>One audited engine, many trees on top, with thin typed layers between.</P>
          <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
            {[
              ["Torna engine", "C / SBF", "The parallel ordered B+ tree, one node per account. 15 instructions."],
              ["torna-cpi", "Rust / SBF", "invoke_signed helpers so a program drives Torna as a book-authority PDA."],
              ["orderbook (TornaDEX)", "Rust / SBF", "Two-sided escrow CLOB: a market = two trees + vaults, place/cancel/match."],
              ["torna-sdk (Rust)", "Rust client", "The PathPlanner: key-based ix builders, accounts resolved off-chain."],
              ["torna-sdk (npm)", "TypeScript", "1:1 port of the Rust SDK, byte-equivalent, published on npm."],
              ["cpi-probe", "Rust / SBF", "Composability proof: a program CPIs InsertFast and parallelism survives."],
            ].map((r, i) => (
              <div key={r[0]} className={`grid grid-cols-[1.2fr_0.8fr_2fr] gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                <span className="font-medium text-fg">{r[0]}</span>
                <span className="nums text-faint">{r[1]}</span>
                <span className="text-muted">{r[2]}</span>
              </div>
            ))}
          </div>
        </section>

        {/* RESOURCES */}
        <section>
          <H id="resources" kicker="Why this shape">The three scarce resources</H>
          <P>Every Solana program is bound by three limits. Torna&apos;s layout is chosen to win all three; a single-account slab loses all three.</P>
          <ul className="mt-4 space-y-2 text-[15px] text-muted">
            <li><strong className="text-fg">Per-tx account budget</strong> (the scarcest, ~35 legacy / ~256 with ALT). High fanout means height ~3, so an operation touches ~3 node accounts, not one huge slab.</li>
            <li><strong className="text-fg">Account-lock parallelism (Sealevel)</strong>. One node per account means disjoint-key writes do not share a writable account, so the scheduler runs them in the same slot.</li>
            <li><strong className="text-fg">Rent</strong>. Node size is parameterized by value size; high fanout amortizes the per-account overhead.</li>
          </ul>
        </section>

        {/* NODE */}
        <section>
          <H id="node" kicker="How it works">One B+ tree, one account per node</H>
          <P>
            The header is read-only on the hot path; only the target leaf is writable. So two makers
            landing in different leaves carry disjoint write sets and commit in the same slot. The
            allocator (a separate account) is touched only on the cold path, so plain inserts never
            write-lock the shared header.
          </P>
          <div className="mt-5 rounded-xl border border-line bg-panel p-5"><BTree /></div>
          <P>
            <span className="text-fg">Hot path</span> (InsertFast, UpdateFast, DeleteFast, Find,
            RangeScan, and the batch variants): header read-only, no CPI, only the leaf writable, fully
            parallel. <span className="text-fg">Cold path</span> (Insert with a split, Delete with a
            merge): touches the allocator and CPIs the system program to create or close node accounts.
            Keeper bots run compaction off-peak so the hot path stays split-free.
          </P>
        </section>

        {/* INSTRUCTIONS */}
        <section>
          <H id="instructions" kicker="The engine">15 instructions</H>
          <P>The discriminator is the first instruction-data byte. Hot ops parallelize; cold ops touch the allocator and serialize.</P>
          <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
            <div className="grid grid-cols-[auto_1.3fr_2.4fr_auto] gap-3 bg-panel-hi px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              <span>disc</span><span>name</span><span>purpose</span><span>path</span>
            </div>
            {INSTRUCTIONS.map(([d, name, purpose, kind], i) => (
              <div key={name} className={`grid grid-cols-[auto_1.3fr_2.4fr_auto] items-center gap-3 px-4 py-2 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                <span className="nums w-6 text-faint">{d}</span>
                <span className="font-medium text-fg">{name}</span>
                <span className="text-muted">{purpose}</span>
                <Tag kind={kind} />
              </div>
            ))}
          </div>
        </section>

        {/* ABI */}
        <section>
          <H id="abi" kicker="Frozen contract (v4)">On-chain layout</H>
          <P>
            The byte layouts are frozen and locked by compile-time asserts in the engine. The tenant
            boundary is <span className="nums text-fg">tree_uid = sha256(creator || tree_id)[..16]</span>,
            a 128-bit id stamped in every node and checked at every node-validation site (tree_id alone
            is a client-chosen u32 that collides across creators).
          </P>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-line bg-panel p-4">
              <div className="text-sm font-semibold text-fg">Node header · 44 bytes</div>
              <div className="nums mt-2 space-y-1 text-xs text-muted">
                {[["0", "is_leaf"], ["2", "key_count (u16)"], ["8", "tree_id (u32)"], ["12", "node_idx (u64)"], ["20", "next_leaf_idx (u64)"], ["28", "tree_uid (16)"]].map(([o, f]) => (
                  <div key={o} className="flex justify-between"><span className="text-faint">@{o}</span><span className="text-fg">{f}</span></div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-line bg-panel p-4">
              <div className="text-sm font-semibold text-fg">Tree header · 146 bytes</div>
              <div className="nums mt-2 space-y-1 text-xs text-muted">
                {[["8", "creator (32)"], ["48", "fanout (u16)"], ["54", "root_node_idx"], ["62", "height (u32)"], ["82", "structure_epoch"], ["122", "tree_uid (16)"]].map(([o, f]) => (
                  <div key={o} className="flex justify-between"><span className="text-faint">@{o}</span><span className="text-fg">{f}</span></div>
                ))}
              </div>
            </div>
          </div>
          <P>PDA seeds are creator-namespaced, so a tree_id is local to its creator:</P>
          <Code>{`header     ["thdr",   creator, tree_id]
node(i)    ["tnode",  creator, tree_id, node_idx]
allocator  ["talloc", creator, tree_id]
delegate   ["tdlg",   creator, tree_id]`}</Code>
        </section>

        {/* KEY */}
        <section>
          <H id="key" kicker="The book is the tree">A single 32-byte key</H>
          <P>Compared byte-by-byte, one big-endian 32-byte key sorts the whole book into price-time priority. There is no secondary index, the tree is the sorted book.</P>
          <div className="mt-5"><OrderKey /></div>
          <div className="mt-6 overflow-hidden rounded-xl border border-line text-sm">
            {[
              ["Place limit order", "InsertFast (Insert if the leaf splits)", "parallel"],
              ["Cancel order", "DeleteFast (Delete if a node merges)", "parallel"],
              ["Reduce on partial fill", "UpdateFast (value-only, in place)", "parallel"],
              ["Best bid / ask", "read the leftmost / rightmost leaf", "read"],
              ["Match / take", "read crossing orders + settle + Update/Delete", "serial"],
            ].map((r, i) => (
              <div key={r[0]} className={`grid grid-cols-[1.1fr_1.6fr_auto] gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                <span className="font-medium text-fg">{r[0]}</span>
                <span className="nums text-muted">{r[1]}</span>
                <span className={r[2] === "serial" ? "text-ask" : r[2] === "read" ? "text-parallel" : "text-bid"}>{r[2]}</span>
              </div>
            ))}
          </div>
          <P>An ask escrows base tokens, a bid escrows quote; a match releases and collects atomically via SPL-Token CPI; cancel refunds. Real escrow, not a toy.</P>
        </section>

        {/* SDK */}
        <section>
          <H id="sdk" kicker="The product">Account resolution is invisible</H>
          <P>
            The client is most of the value. You call with a key and value; the planner reads the tree
            off-chain and returns the exact account set. Node indices, PDA bumps, the descent path, and
            split spares never leave the library. Published as <code className="nums rounded bg-panel-hi px-1.5 py-0.5 text-[13px] text-fg">torna-sdk</code> on npm.
          </P>
          <Code>{`import { Tree, keys } from "torna-sdk";

const tree = new Tree(program, creator, askTreeId);
const key  = keys.orderKey(keys.Side.Ask, price, slot, maker, nonce);

// the planner resolves the exact accounts off-chain
const ix = await tree.insertFastIx(reader, authority, key, value);
// node_idx / bump / path / spares: never touched by you`}</Code>
          <P>It is a 1:1 port of the Rust SDK, asserted byte-for-byte against it with golden vectors and run end-to-end against the real engine.</P>
        </section>

        {/* PERFORMANCE */}
        <section>
          <H id="performance" kicker="Measured, not claimed">Performance</H>
          <P>
            Parallelism benchmark on a real single-node validator (the Agave banking stage, not a
            simulator). Identical compute per transaction; the only difference across workloads is the
            writable lock set. Metric: committed transactions per ~400ms slot under saturation.
          </P>
          <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
            <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-3 bg-panel-hi px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              <span>workload</span><span className="text-right">confirmed</span><span className="text-right">peak / slot</span><span className="text-right">p50 busy</span>
            </div>
            {BENCH.map((r, i) => (
              <div key={r[0]} className={`grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                <span className={`font-medium ${i === 0 ? "text-bid" : "text-fg"}`}>{r[0]}</span>
                <span className="nums text-right text-muted">{r[1]}</span>
                <span className="nums text-right text-fg">{r[2]}</span>
                <span className="nums text-right text-fg">{r[3]}</span>
              </div>
            ))}
          </div>
          <P>
            Disjoint-leaf writes commit <span className="text-bid">~3.4x (peak) to ~6x (p50-busy)</span>{" "}
            more transactions per slot than same-leaf writes, and ~5.9x to ~8.6x more than same
            fee-payer. The same fee-payer case serializes even across different leaves, because the fee
            debit makes the payer a writable lock, so each parallel maker must fund with its own payer.
          </P>
          <Note>
            This measures book maintenance throughput, not matching. Top-of-book is serial by
            definition. A single-node validator has limited banking threads, so a real cluster would
            widen the ratio, not narrow it.
          </Note>

          <P className="mt-8">Compute units at production scale, measured on the real engine (make cu):</P>
          <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
            {CU.map((r, i) => (
              <div key={r[0]} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                <span className="text-muted">{r[0]}</span><span className="nums font-medium text-fg">{r[1]}</span>
              </div>
            ))}
          </div>
          <P>Single-key hot operations stay under the 200k default budget even at fanout 128; the batch operations request a higher limit and remain far under the 1.4M per-transaction cap.</P>
        </section>

        {/* SECURITY */}
        <section>
          <H id="security" kicker="Honest posture">Security and testing</H>
          <P>
            Each layer went through in-house adversarial review to convergence (rounds until two
            consecutive clean passes), with independent skeptics attacking from distinct angles.
          </P>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              ["Engine", "5 rounds + a class audit. The recurring class 'program-owned is not tenant-owned' struck four times (node, allocator, scratch, delegate); fixed by binding every caller-provided account to its 128-bit tree_uid."],
              ["Orderbook", "5 rounds. 5 critical + 1 high + 1 medium found and fixed. The headline: a fake-tree match/cancel drained the real vault at ~0 cost, fixed by binding the book to the market config (check_book)."],
              ["SDK", "5 rounds. A faithful 1:1 port with no critical or high finding; added input validation the Rust type system enforced for free."],
              ["Demo + faucet", "5 rounds. The public faucet hardened (atomic mint, on-chain reserve floor, layered rate limits); money-path builders byte-checked against the on-chain oracle."],
            ].map(([t, d]) => (
              <div key={t} className="rounded-xl border border-line bg-panel p-4">
                <div className="text-sm font-semibold text-fg">{t}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
          <P>Test suite, all green and reproducible:</P>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {["host unit + differential 10,042", "inttest 55", "cpitest 7", "sdktest 14", "obtest 51 (token conservation)", "alttest 4", "on-chain differential 8,000 ops", "fuzz 60k, zero memory violations", "TS SDK 12/12"].map((t) => (
              <span key={t} className="nums rounded-md border border-line bg-panel px-2.5 py-1 text-muted">{t}</span>
            ))}
          </div>
          <P>
            The order book&apos;s obtest asserts token conservation after every operation, which is how
            account-binding fund drains were caught (functional tests passed the honest path; only
            adversarial plus conservation testing caught them). The threat model covers cross-tenant
            splicing, delegate injection, scratch corruption, and rent theft, each with a fail-closed
            regression test.
          </P>
          <Note>
            In-house adversarial review is not a substitute for an external audit, which is pending.
            The upgrade-authority policy (immutable after audit vs a timelocked multisig) is the one
            open pre-mainnet trust decision and is not yet decided.
          </Note>
        </section>

        {/* COMPARE */}
        <section>
          <H id="compare" kicker="What it replaces">Hand-rolled slab vs Torna</H>
          <P>Teams hand-write a slab allocator and run an off-chain indexer to read it back. Torna is both: an on-chain index plus a client that resolves every account.</P>
          <div className="mt-5"><Compare /></div>
        </section>

        {/* USE CASES */}
        <section>
          <H id="usecases" kicker="Where it fits">Use cases, honestly scoped</H>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-bid/30 bg-bid/[0.05] p-5">
              <div className="text-sm font-semibold text-bid">Good fit (sorted + parallel)</div>
              <ul className="mt-2 space-y-1 text-sm text-muted">
                {["CLOB / DEX order book (the wedge)", "Liquidation queues", "Leaderboards / top-N", "Token-weight governance", "Proposal / expiry queues"].map((x) => <li key={x}>{x}</li>)}
              </ul>
            </div>
            <div className="rounded-xl border border-ask/30 bg-ask/[0.05] p-5">
              <div className="text-sm font-semibold text-ask">Poor fit (drop)</div>
              <ul className="mt-2 space-y-1 text-sm text-muted">
                {["Options-per-strike trees (rent)", "Trait-per-tree marketplaces (rent)", "Full on-chain time-series (rent)", "Tiny datasets, RFQ, rate oracles (no parallelism need)"].map((x) => <li key={x}>{x}</li>)}
              </ul>
            </div>
          </div>
        </section>

        {/* ROADMAP */}
        <section>
          <H id="roadmap" kicker="Status">Roadmap</H>
          <div className="mt-4 space-y-2 text-sm">
            {[
              ["done", "Engine: 15 instructions, C for SBF, 5 adversarial rounds to convergence"],
              ["done", "torna-sdk (Rust) + torna-cpi crate"],
              ["done", "Orderbook reference CLOB: two-sided escrow, place / cancel / match, cold split, keeper compact"],
              ["done", "TS SDK published to npm as torna-sdk@0.1.0"],
              ["done", "Deployed + live seeded market on devnet, with this demo"],
              ["next", "External audit (in-house review is not an audit)"],
              ["next", "Multi-node devnet benchmark for a stronger number"],
              ["next", "Hosted demo; cascade-aware keeper compaction"],
            ].map(([s, t], i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2.5">
                <span className={`text-[11px] font-semibold uppercase ${s === "done" ? "text-bid" : "text-serial"}`}>{s}</span>
                <span className="text-muted">{t}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
            <a className="hover:text-brand" href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer">torna-sdk on npm</a>
            <a className="hover:text-brand" href={`https://explorer.solana.com/address/${MARKET.tornaProgramId}?cluster=devnet`} target="_blank" rel="noreferrer">engine on explorer</a>
            <a className="hover:text-brand" href={`https://explorer.solana.com/address/${MARKET.orderbookProgramId}?cluster=devnet`} target="_blank" rel="noreferrer">orderbook on explorer</a>
          </div>
        </section>
      </article>
    </div>
  );
}
