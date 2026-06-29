// Docs articles (server-rendered): the two tab bodies. The tab shell + URL-param routing lives in
// app/docs/page.tsx, so code blocks are syntax-highlighted at build time (shiki, via CodeBlock).
import { BTree } from "@/components/diagrams/BTree";
import { OrderKey } from "@/components/diagrams/OrderKey";
import { Market } from "@/components/diagrams/Market";
import { Compare } from "@/components/Compare";
import { Address } from "@/components/ui/Address";
import { CodeBlock as Code } from "@/components/ui/CodeBlock";
import { MARKET, explorerTx } from "@/lib/market";
import tx from "@/lib/sample-tx.json";

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
const RENT: [string, string, string][] = [
  ["Tree header", "146 B", "0.001907"],
  ["Allocator", "32 B", "0.001114"],
  ["Node, fanout 8", "692 B", "0.005707"],
  ["Node, fanout 64", "4,724 B", "0.033770"],
  ["Market config", "229 B", "0.002485"],
  ["SPL token vault", "165 B", "0.002039"],
  ["SPL mint", "82 B", "0.001462"],
];

export const TORNA_TOC: [string, string][] = [
  ["overview", "Overview"],
  ["stack", "The stack"],
  ["resources", "Three scarce resources"],
  ["node", "One node per account"],
  ["instructions", "Instruction set"],
  ["wire", "Instruction wire format"],
  ["abi", "On-chain layout (ABI)"],
  ["concurrency", "Concurrency & errors"],
  ["authority", "Authority & delegates"],
  ["sdk", "The SDK"],
  ["quickstart", "Quickstart"],
  ["performance", "Performance"],
  ["economics", "Economics (rent)"],
  ["security", "Security & testing"],
  ["reproduce", "Reproduce"],
  ["compare", "Slab vs Torna"],
  ["usecases", "Use cases"],
  ["limits", "Limitations"],
  ["roadmap", "Roadmap"],
];
export const DEX_TOC: [string, string][] = [
  ["overview", "Overview"],
  ["live", "Live on devnet"],
  ["market", "Market structure"],
  ["key", "The order key"],
  ["clob", "CLOB operations"],
  ["security", "Escrow & security"],
];

export function TornaDocs() {
  return (
    <article className="min-w-0 max-w-3xl space-y-16">
      <header>
        <h1 className="display text-4xl font-semibold tracking-tight">
          <span className="text-gradient">Torna</span>, the primitive
        </h1>
        <P>
          Torna is a sorted key to value store on Solana where every B+ tree node lives in its own
          account. Sorting comes from the B+ tree; parallelism comes from one-node-per-account, so writes
          at different keys carry disjoint write sets and the Sealevel scheduler runs them in the same
          slot; and the SDK resolves the exact accounts off-chain. It is a generic index primitive, not a
          matching engine. The engine is written in C for SBF. Build any sorted state with concurrent
          writers on it; the TornaDEX tab is one worked example.
        </P>
        <Note>
          Torna parallelizes <span className="text-fg">maintenance</span> (writes across different keys),
          not a serial consumer like top-of-book matching. The numbers here are measured on a single-node
          validator banking stage; devnet is shared, so the controlled number is the honest one. In-house
          adversarial review is not an external audit, which is still pending.
        </Note>
      </header>

      <section>
        <H id="overview" kicker="The idea">A sorted index, without the slab</H>
        <P>
          Sorted on-chain state with concurrent writers is hard on Solana. The usual answer is a single
          giant slab account plus an off-chain indexer to read it back. Torna replaces both: sorting comes
          from a B+ tree, parallelism from putting one node in each account, and the client SDK resolves
          the exact accounts off-chain so node indices, bumps, paths, and split spares never reach the
          developer.
        </P>
        <P>
          The moat is not the algorithm, anyone can write a B-tree. It is the three-constraint design
          below plus a typed client that makes account resolution invisible, and being the canonical,
          audited primitive.
        </P>
      </section>

      <section>
        <H id="stack" kicker="Architecture">Core, plus what is built on it</H>
        <P>One audited engine, many trees on top, with thin typed layers between.</P>
        <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
          {[
            ["Torna engine", "C / SBF", "The parallel ordered B+ tree, one node per account. 15 instructions."],
            ["torna-cpi", "Rust / SBF", "invoke_signed helpers so a program drives Torna as a book-authority PDA."],
            ["orderbook (TornaDEX)", "Rust / SBF", "Two-sided escrow CLOB: a market = two trees + vaults, place/cancel/match."],
            ["torna-sdk (Rust)", "Rust client", "The PathPlanner: key-based ix builders, accounts resolved off-chain. On crates.io."],
            ["torna-sdk (npm)", "TypeScript", "1:1 port of the Rust SDK, byte-equivalent. On npm."],
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

      <section>
        <H id="resources" kicker="Why this shape">The three scarce resources</H>
        <P>Every Solana program is bound by three limits. Torna&apos;s layout is chosen to win all three; a single-account slab loses all three.</P>
        <ul className="mt-4 space-y-2 text-[15px] text-muted">
          <li><strong className="text-fg">Per-tx account budget</strong> (the scarcest, ~35 legacy / ~256 with ALT). High fanout means height ~3, so an operation touches ~3 node accounts, not one huge slab.</li>
          <li><strong className="text-fg">Account-lock parallelism (Sealevel)</strong>. One node per account means disjoint-key writes do not share a writable account, so the scheduler runs them in the same slot.</li>
          <li><strong className="text-fg">Rent</strong>. Node size is parameterized by value size; high fanout amortizes the per-account overhead.</li>
        </ul>
      </section>

      <section>
        <H id="node" kicker="How it works">One B+ tree, one account per node</H>
        <P>
          The header is read-only on the hot path; only the target leaf is writable. So two writers at
          different leaves carry disjoint write sets and commit in the same slot. The allocator (a separate
          account) is touched only on the cold path, so plain inserts never write-lock the shared header.
        </P>
        <div className="mt-5 rounded-xl border border-line bg-panel p-5"><BTree /></div>
        <P>
          <span className="text-fg">Hot path</span> (InsertFast, UpdateFast, DeleteFast, Find, RangeScan,
          and the batch variants): header read-only, no CPI, only the leaf writable, fully parallel.{" "}
          <span className="text-fg">Cold path</span> (Insert with a split, Delete with a merge): touches
          the allocator and CPIs the system program to create or close node accounts. Keeper bots run
          compaction off-peak so the hot path stays split-free.
        </P>
      </section>

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

      <section>
        <H id="wire" kicker="Bytes on the wire">Instruction wire format</H>
        <P>
          Every instruction is a discriminator byte followed by its fields. Multi-byte integers are
          little-endian on the wire; a 32-byte key inside is big-endian. The descent path (root to leaf)
          is resolved by the SDK and appended after the fixed accounts.
        </P>
        <Code>{`InsertFast (16)   [16][key 32][value vs][path_len u8]
UpdateFast (17)   [17][key 32][value vs][path_len u8]
DeleteFast (18)   [18][key 32][path_len u8]
Find       (3)    [ 3][key 32][path_len u8]   -> return_data: [found u8][value vs]
Insert     (2)    [ 2][key 32][value vs][path_len][spare_count][rent_node u64][bumps..]   (cold)
InitTree   (0)    [ 0][tree_id u32][hdr_bump][alloc_bump][value_size u16][fanout u16][rent_hdr u64][rent_alloc u64]`}</Code>
        <P>
          The hot-path account set is always: header (read-only), authority (read-only signer), then the
          path nodes with only the leaf writable. That exact shape, header read-only and a single leaf
          writable, is what lets disjoint-key operations land in the same slot. value size (vs) is fixed
          per tree at init.
        </P>
      </section>

      <section>
        <H id="abi" kicker="Frozen contract (v4)">On-chain layout</H>
        <P>
          The byte layouts are frozen and locked by compile-time asserts in the engine. The tenant
          boundary is <span className="nums text-fg">tree_uid = sha256(creator || tree_id)[..16]</span>, a
          128-bit id stamped in every node and checked at every node-validation site (tree_id alone is a
          client-chosen u32 that collides across creators).
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

      <section>
        <H id="concurrency" kicker="Correctness under load">Concurrency, staleness, and errors</H>
        <P>
          The header carries a <span className="nums text-fg">structure_epoch</span> bumped only on a
          structural change (split, merge, or root change), never on a plain insert. A client resolves a
          path from current state, then submits; between resolving and landing, a concurrent writer may
          have split or merged a node and invalidated the cached path. The engine returns ERR_BAD_PATH and
          the client just re-resolves from fresh state and resubmits. Comparing the cached structure_epoch
          detects this cheaply, with no hot-path contention (plain inserts never bump it).
        </P>
        <P>The SDK ships a small retry model for this: resolve, submit, and on a stale path re-resolve and try again; a real error stops immediately.</P>
        <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
          {[
            ["102", "ERR_NEED_SPLIT_SLOT", "InsertFast hit a full leaf, fall back to the cold Insert (split)"],
            ["103", "ERR_DUPLICATE_KEY", "the key already exists"],
            ["104", "ERR_KEY_NOT_FOUND", "UpdateFast or DeleteFast on an absent key"],
            ["105", "ERR_BAD_PATH", "node_idx or tree_uid mismatch, the path went stale, re-resolve"],
          ].map((r, i) => (
            <div key={r[0]} className={`grid grid-cols-[auto_1.3fr_2.4fr] items-center gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
              <span className="nums w-8 text-faint">{r[0]}</span>
              <span className="nums font-medium text-fg">{r[1]}</span>
              <span className="text-muted">{r[2]}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <H id="authority" kicker="Write access">Authority and delegates</H>
        <P>
          Each tree has a primary authority (set at init, rotatable via TransferAuthority). Write
          instructions accept the primary authority OR a PDA-validated delegate. Delegates are added and
          removed by the primary only (AddDelegate / RemoveDelegate, up to 8), and each delegate list is
          stamped with the authorizing authority, so a TransferAuthority invalidates a stale delegate list.
          The authority signs as a <span className="text-fg">read-only signer</span> on the hot path, so a
          shared read lock does not serialize, writes stay parallel even when an integrating program drives
          Torna through a CPI as its own PDA.
        </P>
        <P>Transfer to the all-zero authority is forbidden; it would silently open the tree.</P>
      </section>

      <section>
        <H id="sdk" kicker="The product">Account resolution is invisible</H>
        <P>
          The client is most of the value. You call with a key and value; the planner reads the tree
          off-chain and returns the exact account set. Node indices, PDA bumps, the descent path, and split
          spares never leave the library. Published as <code className="nums rounded bg-panel-hi px-1.5 py-0.5 text-[13px] text-fg">torna-sdk</code> on npm (TypeScript) and crates.io (Rust).
        </P>
        <Code lang="typescript">{`import { Tree, keys } from "torna-sdk";

const tree = new Tree(program, creator, treeId);
const key  = keys.orderKey(keys.Side.Ask, price, slot, maker, nonce);

// the planner resolves the exact accounts off-chain
const ix = await tree.insertFastIx(reader, authority, key, value);
// node_idx / bump / path / spares: never touched by you`}</Code>
        <P>It is a 1:1 port of the Rust SDK, asserted byte-for-byte against it with golden vectors and run end-to-end against the real engine.</P>
      </section>

      <section>
        <H id="quickstart" kicker="Build with it">Quickstart</H>
        <P>Install the SDK and web3.js, then resolve and send instructions. Reads walk the tree off-chain with no transaction; writes are one call each.</P>
        <Code lang="bash">{`npm install torna-sdk @solana/web3.js`}</Code>
        <Code lang="typescript">{`import { Connection, PublicKey } from "@solana/web3.js";
import { Tree, keys, type AccountReader } from "torna-sdk";

const connection = new Connection("https://api.devnet.solana.com");
const reader: AccountReader = {
  async accountData(key) {
    const i = await connection.getAccountInfo(key);
    return i ? Uint8Array.from(i.data) : null;
  },
};

const tree = new Tree(program, creator, /* treeId */ 1);

// read off-chain (no tx): top of book, a page, a single value
const top  = await tree.best(reader);
const page = await tree.scan(reader, 16);
const val  = await tree.get(reader, key);

// hot-path insert: header read-only, only the leaf writable -> parallel
const key = keys.orderKey(keys.Side.Ask, price, slot, maker, nonce);
const ix  = await tree.insertFastIx(reader, authority, key, value);

// if the leaf is full the engine returns 102; fall back to the cold split path
const cold = await tree.insertIx(reader, payer, key, value, rentNode);`}</Code>
      </section>

      <section>
        <H id="performance" kicker="Measured, not claimed">Performance</H>
        <P>
          Parallelism benchmark on a real single-node validator (the Agave banking stage, not a simulator).
          Identical compute per transaction; the only difference across workloads is the writable lock set.
          Metric: committed transactions per ~400ms slot under saturation.
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
          Disjoint-leaf writes commit <span className="text-bid">~3.4x (peak) to ~6x (p50-busy)</span> more
          transactions per slot than same-leaf writes, and ~5.9x to ~8.6x more than same fee-payer. The
          same fee-payer case serializes even across different leaves, because the fee debit makes the
          payer a writable lock, so each parallel writer must fund with its own payer.
        </P>
        <Note>
          This measures maintenance throughput, not a serial consumer. A single-node validator has limited
          banking threads, so a real cluster would widen the ratio, not narrow it.
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

      <section>
        <H id="economics" kicker="What it costs">Economics (rent)</H>
        <P>
          Solana charges a per-account rent deposit sized by bytes. These are real devnet numbers. Rent is
          a <span className="text-fg">refundable deposit, not a fee</span>: it is reclaimed when an account
          is closed, and Torna returns a merged node&apos;s rent to the payer (node indices are monotonic
          and never reused, so there is no stale-reference hazard).
        </P>
        <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
          <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-3 bg-panel-hi px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
            <span>account</span><span className="text-right">bytes</span><span className="text-right">rent (SOL)</span>
          </div>
          {RENT.map((r, i) => (
            <div key={r[0]} className={`grid grid-cols-[1.6fr_1fr_1fr] gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
              <span className="text-muted">{r[0]}</span>
              <span className="nums text-right text-faint">{r[1]}</span>
              <span className="nums text-right font-medium text-fg">{r[2]}</span>
            </div>
          ))}
        </div>
        <P>
          Derived: an empty tree is <span className="nums text-fg">~0.003 SOL</span> (header + allocator);
          standing up a full market (two trees + two vaults + config) is{" "}
          <span className="nums text-fg">~0.024 SOL</span> plus any new mints. A resting entry is one slot
          in an existing leaf, not a new account, so its marginal rent is the leaf rent amortized over the
          fanout, roughly <span className="nums text-fg">0.0005 SOL</span> at fanout 64, reclaimed when the
          leaf later merges. The recurring per-transaction cost is just the ~5000-lamport (0.000005 SOL)
          network fee; new node accounts are created only on a split, which keepers run off-peak.
        </P>
      </section>

      <section>
        <H id="security" kicker="Honest posture">Security and testing</H>
        <P>
          The engine and SDK went through in-house adversarial review to convergence (rounds until two
          consecutive clean passes), with independent skeptics attacking from distinct angles. (The
          orderbook&apos;s own review is in the TornaDEX tab.)
        </P>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            ["Engine", "5 rounds + a class audit. The recurring class 'program-owned is not tenant-owned' struck four times (node, allocator, scratch, delegate); fixed by binding every caller-provided account to its 128-bit tree_uid."],
            ["SDK", "5 rounds. A faithful 1:1 port with no critical or high finding; added input validation the Rust type system enforced for free."],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-line bg-panel p-4">
              <div className="text-sm font-semibold text-fg">{t}</div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
        <P>Test suite, all green and reproducible:</P>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {["host unit + differential 10,042", "inttest 55", "cpitest 7", "sdktest 14", "alttest 4", "on-chain differential 8,000 ops", "fuzz 60k, zero memory violations", "TS SDK 12/12"].map((t) => (
            <span key={t} className="nums rounded-md border border-line bg-panel px-2.5 py-1 text-muted">{t}</span>
          ))}
        </div>
        <P>
          The threat model covers cross-tenant splicing, delegate injection, scratch corruption, and rent
          theft, each with a fail-closed regression test. The engine only CPIs the system program, so there
          is no reentrancy surface.
        </P>
        <Note>
          In-house adversarial review is not a substitute for an external audit, which is pending. The
          upgrade-authority policy (immutable after audit vs a timelocked multisig) is the one open
          pre-mainnet trust decision and is not yet decided.
        </Note>
      </section>

      <section>
        <H id="reproduce" kicker="Run it yourself">Reproduce</H>
        <P>Everything here is reproducible from the repo. Add the Solana platform-tools to PATH, then from the engine directory:</P>
        <Code lang="bash">{`make test         # host unit + differential (assertions on)
make sbf          # build the on-chain program -> sbf/out/torna.so
make integration  # LiteSVM: smoke, inttest, cpitest, sdktest, obtest, alttest
make diff         # on-chain differential vs an oracle (8000 ops)
make fuzz FUZZ_ITERS=60000   # fuzz every handler for memory safety
make cu           # compute units at production scale (F = 16 / 64 / 128)
make all          # all of the above
make ts           # TS SDK: golden vectors + bankrun e2e (12/12)`}</Code>
        <P>The parallelism benchmark spins a real single-node validator and blasts disjoint vs conflicting workloads:</P>
        <Code lang="bash">{`cd bench && ./run.sh`}</Code>
      </section>

      <section>
        <H id="compare" kicker="What it replaces">Hand-rolled slab vs Torna</H>
        <P>Teams hand-write a slab allocator and run an off-chain indexer to read it back. Torna is both: an on-chain index plus a client that resolves every account.</P>
        <div className="mt-5"><Compare /></div>
      </section>

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

      <section>
        <H id="limits" kicker="What it does not do">Limitations</H>
        <P>Stated plainly, so integrators can plan around them:</P>
        <ul className="mt-4 space-y-2 text-[15px] text-muted">
          <li><strong className="text-fg">Serial consumers stay serial.</strong> A single contention point like top-of-book matching cannot be parallelized; Torna parallelizes maintenance, not the consumer.</li>
          <li><strong className="text-fg">The fee-payer is a writable lock.</strong> Two transactions from the same payer serialize even on different leaves, so each parallel writer must fund with its own payer.</li>
          <li><strong className="text-fg">Ordering tiebreaks are client-supplied.</strong> A strict global counter is deliberately not used because it would serialize every write; uniqueness lives in a writer-chosen tail.</li>
          <li><strong className="text-fg">Keys are strict-unique, values fixed-width</strong> (1 to 128 bytes per tree). Larger payloads store a 32-byte pointer to a side account the developer owns.</li>
          <li><strong className="text-fg">Not externally audited yet</strong>, and the upgrade-authority policy (immutable vs timelocked multisig) is not yet decided.</li>
        </ul>
      </section>

      <section>
        <H id="roadmap" kicker="Status">Roadmap</H>
        <div className="mt-4 space-y-2 text-sm">
          {[
            ["done", "Engine: 15 instructions, C for SBF, 5 adversarial rounds to convergence"],
            ["done", "torna-sdk (Rust) + torna-cpi crate"],
            ["done", "Orderbook reference CLOB: two-sided escrow, place / cancel / match, cold split, keeper compact"],
            ["done", "Published: torna-sdk on npm + crates.io, and torna-cpi on crates.io, v0.1.0"],
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
          <a className="hover:text-brand" href="https://github.com/nzengi/torna" target="_blank" rel="noreferrer">GitHub</a>
          <a className="hover:text-brand" href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer">torna-sdk on npm</a>
          <a className="hover:text-brand" href="https://crates.io/crates/torna-sdk" target="_blank" rel="noreferrer">torna-sdk on crates.io</a>
          <a className="hover:text-brand" href={`https://explorer.solana.com/address/${MARKET.tornaProgramId}?cluster=devnet`} target="_blank" rel="noreferrer">engine on explorer</a>
        </div>
      </section>
    </article>
  );
}

export function DexDocs() {
  return (
    <article className="min-w-0 max-w-3xl space-y-16">
      <header>
        <h1 className="display text-4xl font-semibold tracking-tight">
          <span className="text-gradient">TornaDEX</span>, the reference app
        </h1>
        <P>
          TornaDEX is a central limit order book built entirely on Torna, the reference integration that
          proves the primitive end to end. A market is two Torna trees (ask + bid) plus SPL-Token escrow,
          owned by a book PDA. Place, cancel, and match are real on-chain transactions. This tab documents
          how the CLOB maps onto the index; the Torna tab documents the index itself.
        </P>
        <Note>
          TornaDEX parallelizes book <span className="text-fg">maintenance</span> (maker place and cancel
          across prices), not matching. Top-of-book matching is price-time serial and nothing can change
          that. In a liquid, maker-heavy book, maker traffic dominates, so the parallel win still carries.
        </Note>
      </header>

      <section>
        <H id="overview" kicker="What it is">A real CLOB on Torna</H>
        <P>
          The flagship example of the primitive. Each resting order is one tree entry; nothing about the
          order book lives outside the two trees and the vaults. Your own app would use the same SDK with a
          different key and value, no slab and no indexer. Trade it live on the Trade page.
        </P>
      </section>

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
          Here is an actual <span className="text-fg">PlaceOrder</span> transaction captured from devnet.
          The orderbook program escrows tokens via an SPL-Token CPI, then CPIs the Torna engine&apos;s
          InsertFast to insert the order into the on-chain B+ tree, atomically in one transaction.
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
          is the Torna engine running InsertFast as a CPI from the book authority PDA, consuming roughly 3k
          compute units; the whole place costs ~11k CU and a 5000-lamport fee.
        </P>
      </section>

      <section>
        <H id="market" kicker="Structure">Market structure</H>
        <P>
          A market is two Torna trees (ask + bid), two SPL token vaults, and a config, all owned and bound
          by one book PDA with seeds <span className="nums text-fg">[&quot;book&quot;, market_id]</span>.
          The book PDA is the sole write authority of both trees and the owner of both vaults. A separate
          config PDA <span className="nums text-fg">[&quot;mkt&quot;, market_id]</span> stores and validates
          the canonical mints, vaults, engine program, and tree headers, so a taker can never settle
          against a fake tree while draining the real vault.
        </P>
        <div className="mt-5 rounded-xl border border-line bg-panel p-5"><Market /></div>
        <P>
          InitMarket binds everything once: it checks each tree header is a genuine, non-open engine tree
          whose authority is the book PDA, that the vaults are the book PDA&apos;s token accounts of the
          declared mints, and that the trees are clean (no pre-seeded, unescrowed orders). After that only
          the book PDA can mutate the book, so every resting order is backed by real escrow.
        </P>
      </section>

      <section>
        <H id="key" kicker="The book is the tree">A single 32-byte key</H>
        <P>Compared byte-by-byte, one big-endian 32-byte key sorts the whole book into price-time priority. There is no secondary index, the tree is the sorted book.</P>
        <div className="mt-5"><OrderKey /></div>
        <P>
          The price field is stored big-endian so byte order matches numeric order; bids store{" "}
          <span className="nums text-fg">u64 max minus price</span> so the best bid sorts first. The
          (maker, nonce) tail is a writer-unique tiebreaker, so two makers quoting the same price-time never
          collide and never serialize on each other.
        </P>
      </section>

      <section>
        <H id="clob" kicker="Mapping">CLOB operations to engine ops</H>
        <P>Each order-book action is one or two engine instructions plus SPL-Token movement.</P>
        <div className="mt-4 overflow-hidden rounded-xl border border-line text-sm">
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
        <P>
          An ask escrows base tokens, a bid escrows quote (price times size); a match releases and collects
          atomically via SPL-Token CPI; a cancel refunds the escrow. Real escrow backs every resting order.
          The orderbook instruction data is <span className="nums text-fg">[disc][side][price 8][size 8]...</span>,
          which the Explorer decodes back into buy/sell size at price.
        </P>
      </section>

      <section>
        <H id="security" kicker="Honest posture">Escrow and security</H>
        <P>
          The orderbook went through the same in-house adversarial review to convergence as the engine, five
          rounds, because it is the money path.
        </P>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            ["Orderbook", "5 rounds. 5 critical + 1 high + 1 medium found and fixed. The headline: a fake-tree match/cancel drained the real vault at ~0 cost, fixed by binding the book to the market config (check_book)."],
            ["Demo + faucet", "5 rounds. The public faucet hardened (atomic mint, on-chain reserve floor, layered rate limits); money-path builders byte-checked against the on-chain oracle."],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-line bg-panel p-4">
              <div className="text-sm font-semibold text-fg">{t}</div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
        <P>
          The conservation test (obtest, 51 cases) asserts <span className="text-fg">token conservation
          after every operation</span>, which is how account-binding fund drains were caught: functional
          tests passed the honest path; only adversarial plus conservation testing caught them. Every
          market read and write validates the book against its config first, so a forged tree or vault is
          rejected before any token moves.
        </P>
        <Note>
          In-house adversarial review is not an external audit, which is pending. Treat TornaDEX as a
          devnet reference, not a production-audited exchange.
        </Note>
      </section>
    </article>
  );
}
