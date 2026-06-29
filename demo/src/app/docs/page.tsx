import { BTree } from "@/components/diagrams/BTree";
import { OrderKey } from "@/components/diagrams/OrderKey";
import { MARKET, explorerAddr } from "@/lib/market";

const TOC = [
  ["what", "What is Torna"],
  ["resources", "The three scarce resources"],
  ["node", "One node per account"],
  ["paths", "Hot path vs cold path"],
  ["key", "The order key"],
  ["clob", "Order book → Torna"],
  ["sdk", "The SDK"],
  ["security", "Security & status"],
] as const;

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="display scroll-mt-20 text-2xl font-semibold tracking-tight text-fg">
      {children}
    </h2>
  );
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[15px] leading-relaxed text-muted">{children}</p>;
}
function Code({ children }: { children: string }) {
  return (
    <pre className="nums mt-4 overflow-x-auto rounded-lg border border-line bg-panel p-4 text-xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-6xl gap-10 px-6 py-12 lg:grid lg:grid-cols-[200px_1fr]">
      {/* TOC */}
      <aside className="hidden lg:block">
        <nav className="sticky top-20 space-y-1 text-sm">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">On this page</div>
          {TOC.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="block rounded px-2 py-1 text-muted transition-colors duration-100 hover:bg-panel-hi hover:text-fg">
              {label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Documentation</p>
        <h1 className="display mt-2 text-4xl font-semibold tracking-tight">Torna, explained from scratch</h1>
        <P>
          Torna is the first parallel, ordered, on-chain index primitive for Solana, a sorted
          key→value store you use like a local map. TornaDEX is the reference order book built on it.
          This page assumes no prior knowledge.
        </P>

        <div className="mt-12 space-y-14">
          <section>
            <H id="what">What is Torna</H>
            <P>
              An order book needs two things: keep orders <em>sorted</em> (best price first), and let
              many traders update it <em>at once</em>. On Solana both are hard. Torna solves them with a
              B+ tree, a balanced sorted tree, where <strong className="text-fg">every node is its own
              account</strong>. Sorting comes from the tree; parallelism comes from the one-account-per-node
              layout. Torna is a generic sorted index, not a matching engine; the order book program sits
              on top.
            </P>
          </section>

          <section>
            <H id="resources">The three scarce resources</H>
            <P>Every Solana program is bound by three limits. Torna’s layout is chosen to win all three:</P>
            <ul className="mt-4 space-y-2 text-[15px] text-muted">
              <li><strong className="text-fg">Account budget</strong>, a transaction can only reference so many accounts. High tree fanout keeps height ~3, so an operation touches ~3 node accounts.</li>
              <li><strong className="text-fg">Account-lock parallelism</strong>, Sealevel runs transactions together when their writable accounts don’t overlap. One node per account makes disjoint-key writes disjoint.</li>
              <li><strong className="text-fg">Rent</strong>, every account costs a rent deposit. Node size scales with the value, and high fanout amortizes the per-account overhead.</li>
            </ul>
            <P>A textbook single-account slab order book fails all three: it loads the whole book per tx, serializes every write behind one lock, and wastes space.</P>
          </section>

          <section>
            <H id="node">One node per account</H>
            <P>
              The header holds tree metadata and is <strong className="text-fg">read-only</strong> on the
              hot path. Internal nodes route; leaves hold the orders. Because the two makers below descend
              to different leaves, their writable sets are disjoint and the scheduler commits both in the
              same slot.
            </P>
            <div className="mt-5 rounded-xl border border-line bg-panel p-5"><BTree /></div>
          </section>

          <section>
            <H id="paths">Hot path vs cold path</H>
            <P>
              Most operations are <strong className="text-fg">hot</strong>: insert/update/delete into an
              existing leaf. The header stays read-only, no new accounts are created, only the target leaf
              is writable, fully parallel. Occasionally a leaf fills and must split (insert) or empties and
              must merge (delete): the <strong className="text-fg">cold path</strong> touches an allocator
              and creates/closes node accounts. Keeper bots run splits/compaction off-peak so the hot path
              stays split-free.
            </P>
          </section>

          <section>
            <H id="key">The order key</H>
            <P>
              Keys are compared byte-by-byte. Encoding the order as a single 32-byte big-endian key makes
              that byte order equal price-time priority, so the tree <em>is</em> the sorted book, with no
              secondary index.
            </P>
            <div className="mt-5"><OrderKey /></div>
          </section>

          <section>
            <H id="clob">Order book → Torna</H>
            <P>A market is two trees (asks + bids) plus token vaults, all owned by a book PDA. CLOB operations map directly onto Torna:</P>
            <div className="mt-4 overflow-hidden rounded-lg border border-line text-sm">
              {[
                ["Place limit order", "InsertFast (Insert if the leaf splits)", "parallel"],
                ["Cancel order", "DeleteFast (Delete if a node merges)", "parallel"],
                ["Reduce on partial fill", "UpdateFast (value-only, in place)", "parallel"],
                ["Best bid / ask", "read the leftmost / rightmost leaf", "read"],
                ["Match / take", "read crossing orders + settle + Update/Delete", "serial"],
              ].map((r, i) => (
                <div key={r[0]} className={`grid grid-cols-[1.1fr_1.4fr_auto] gap-3 px-4 py-2.5 ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
                  <span className="font-medium text-fg">{r[0]}</span>
                  <span className="nums text-muted">{r[1]}</span>
                  <span className={r[2] === "serial" ? "text-serial" : r[2] === "read" ? "text-faint" : "text-bid"}>{r[2]}</span>
                </div>
              ))}
            </div>
            <P>Escrow is real: an ask locks base tokens, a bid locks quote; a match releases and collects atomically via SPL-Token CPI. Cancel refunds.</P>
          </section>

          <section>
            <H id="sdk">The SDK</H>
            <P>
              The client is the product. You call with a key and value; the planner reads the tree
              off-chain and returns the exact accounts, node indices, PDA bumps, descent paths, and split
              spares never leak out. Published as <code className="nums rounded bg-panel-hi px-1.5 py-0.5 text-[13px]">torna-sdk</code> on npm.
            </P>
            <Code>{`import { Tree, keys } from "torna-sdk";

const tree = new Tree(program, creator, askTreeId);
const key  = keys.orderKey(keys.Side.Ask, price, slot, maker, nonce);

// the planner resolves the exact account set off-chain
const ix = await tree.insertFastIx(reader, authority, key, value);
// node_idx / bump / path / spares: never touched by you`}</Code>
            <P>It is a 1:1 port of the Rust SDK, asserted byte-for-byte against it and run end-to-end against the real engine.</P>
          </section>

          <section>
            <H id="security">Security & status</H>
            <P>
              The engine, the orderbook, and the SDK each went through in-house adversarial review to
              convergence (multiple rounds until two consecutive clean passes), with token-conservation
              tests on every money path. This is <strong className="text-fg">not</strong> a substitute for
              an external audit, which is still pending. Everything here runs on devnet.
            </P>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
              <a className="hover:text-brand" href={explorerAddr(MARKET.tornaProgramId)} target="_blank" rel="noreferrer">engine program ↗</a>
              <a className="hover:text-brand" href={explorerAddr(MARKET.orderbookProgramId)} target="_blank" rel="noreferrer">orderbook program ↗</a>
              <a className="hover:text-brand" href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer">torna-sdk on npm ↗</a>
            </div>
          </section>
        </div>
      </article>
    </div>
  );
}
