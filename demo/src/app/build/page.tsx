import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { GithubIcon } from "@/components/ui/GithubIcon";
import { CodeBlock as Code } from "@/components/ui/CodeBlock";
import { Address } from "@/components/ui/Address";
import { LangProvider, LangToggle, DualCode } from "@/components/ui/LangTabs";
import { MARKET } from "@/lib/market";

export const metadata = {
  title: "Build on Torna",
  description:
    "A code-first guide to integrating Torna in TypeScript or Rust: install, write on the hot path, read off-chain, handle splits, drive it from your own program over CPI, and a complete worked example.",
};

const GH = "https://github.com/nzengi/torna";

const TOC: [string, string][] = [
  ["setup", "Setup"],
  ["quickstart", "Quickstart"],
  ["tree", "Create a tree"],
  ["write", "Write"],
  ["read", "Read"],
  ["cold", "When a leaf splits"],
  ["onchain", "From your program"],
  ["example", "Full example"],
  ["errors", "Errors & staleness"],
  ["reference", "Reference"],
];

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="display scroll-mt-24 text-xl font-semibold tracking-tight text-fg">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[14px] leading-relaxed text-muted">{children}</p>;
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

      <LangProvider>
        <article className="min-w-0 max-w-3xl">
          <header className="border-b border-line pb-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Build on Torna</p>
            <h1 className="display mt-2 text-3xl font-semibold tracking-tight">A sorted, parallel index in a few lines</h1>
            <P>
              You bring a 32-byte key and a value; the SDK resolves every account off-chain and hands you a
              ready instruction. Node indices, PDA bumps, the descent path, and split spares never appear in
              your code.
            </P>
            <Code lang="bash">{`npm i torna-sdk @solana/web3.js      # TypeScript client
cargo add torna-sdk solana-sdk       # Rust client`}</Code>
            <div className="mt-3 flex items-center gap-2 text-xs text-faint">
              <span>Code samples in</span>
              <LangToggle />
            </div>
          </header>

          <div className="space-y-12 py-8">
            {/* SETUP */}
            <section>
              <H id="setup">Setup</H>
              <P>The snippets use a few values you provide:</P>
              <div className="mt-3 space-y-2 text-[14px]">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <code className="nums rounded bg-panel-hi px-1.5 py-0.5 text-[13px] text-fg">program</code>
                  <span className="text-muted">the Torna engine program. On devnet:</span>
                  <Address value={MARKET.tornaProgramId} />
                </div>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <code className="nums rounded bg-panel-hi px-1.5 py-0.5 text-[13px] text-fg">creator</code>
                  <span className="text-muted">the pubkey that namespaces your trees (your project key).</span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <code className="nums rounded bg-panel-hi px-1.5 py-0.5 text-[13px] text-fg">authority / signer / payer</code>
                  <span className="text-muted">the keypair that signs writes and pays fees.</span>
                </div>
              </div>
              <P>Deploy your own engine, or build against the devnet program above; the trade demo and the reference order book both run on it.</P>
            </section>

            {/* QUICKSTART */}
            <section>
              <H id="quickstart">Quickstart</H>
              <P>Insert a key and read it back. The only thing you implement is an <span className="nums text-fg">AccountReader</span> over your transport.</P>
              <DualCode
                ts={<Code lang="typescript">{`import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { Tree, keys, type AccountReader } from "torna-sdk";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// the SDK reads the tree through this; back it with RPC, a cache, or LiteSVM
const reader: AccountReader = {
  async accountData(key) {
    const acc = await connection.getAccountInfo(key, "confirmed");
    return acc ? Uint8Array.from(acc.data) : null;
  },
};

const tree = new Tree(program, creator, 1);

// a 32-byte key + a value (here, an order-book key; any sorted key works)
const key = keys.orderKey(keys.Side.Ask, 100n, 0n, maker, 1n);
const value = orderValue;

// the planner resolves the exact accounts; you sign and send
const ix = await tree.insertFastIx(reader, authority, key, value);
await sendAndConfirmTransaction(connection, new Transaction().add(ix), [signer]);

// read it back: no transaction, no fee
const top = await tree.best(reader);`}</Code>}
                rust={<Code lang="rust">{`use solana_sdk::pubkey::Pubkey;
use torna_sdk::{AccountReader, Tree, keys};

// the SDK reads the tree through this; back it with RPC, a cache, or LiteSVM
struct Reader;
impl AccountReader for Reader {
    fn account_data(&self, key: &Pubkey) -> Option<Vec<u8>> {
        // fetch and return the raw account bytes for \`key\`
        unimplemented!()
    }
}

let reader = Reader;
let tree = Tree::new(program, creator, 1);

// a 32-byte key + a value (here, an order-book key; any sorted key works)
let key = keys::order_key(keys::Side::Ask, 100, 0, &maker, 1);
let value = order_value;

// the planner resolves the exact accounts; you sign and send
let ix = tree.insert_fast_ix(&reader, authority, &key, &value).unwrap();
// send \`ix\` with your client...

// read it back: no transaction, no fee
let top = tree.best(&reader);`}</Code>}
              />
            </section>

            {/* CREATE A TREE */}
            <section>
              <H id="tree">Create a tree (once)</H>
              <P>Pick a <span className="nums text-fg">value_size</span> (1 to 128 bytes, fixed per tree) and a fanout (64 is the default). You get header and allocator PDAs, namespaced by your creator key.</P>
              <DualCode
                ts={<Code lang="typescript">{`const ix = tree.initTreeIx(payer, valueSize, /* fanout */ 64, rentHeader, rentAlloc);`}</Code>}
                rust={<Code lang="rust">{`let ix = tree.init_tree_ix(payer, value_size, /* fanout */ 64, rent_header, rent_alloc);`}</Code>}
              />
            </section>

            {/* WRITE */}
            <section>
              <H id="write">Write (hot path)</H>
              <P>Header read-only, only the target leaf writable, no CPI. So disjoint-key writes from different fee-payers commit in the same slot.</P>
              <DualCode
                ts={<Code lang="typescript">{`const insert = await tree.insertFastIx(reader, authority, key, value);     // add
const update = await tree.updateFastIx(reader, authority, key, newValue);  // overwrite in place
const remove = await tree.deleteFastIx(reader, authority, key);            // remove`}</Code>}
                rust={<Code lang="rust">{`let insert = tree.insert_fast_ix(&reader, authority, &key, &value);      // add
let update = tree.update_fast_ix(&reader, authority, &key, &new_value);  // overwrite in place
let remove = tree.delete_fast_ix(&reader, authority, &key);             // remove`}</Code>}
              />
              <P>Each parallel writer must fund with its own fee-payer, or they serialize on the fee debit.</P>
            </section>

            {/* READ */}
            <section>
              <H id="read">Read (off-chain, free)</H>
              <P>Reads walk the tree over your reader. No transaction, no fee. They return the key and value as raw bytes; decode the value with your own layout.</P>
              <DualCode
                ts={<Code lang="typescript">{`const top  = await tree.best(reader);       // smallest key (top of book)
const page = await tree.scan(reader, 16);   // first 16 entries in order
const val  = await tree.get(reader, key);   // one value by key

if (top) {
  const player = new PublicKey(top.value);  // e.g. a leaderboard value is a 32-byte pubkey
}`}</Code>}
                rust={<Code lang="rust">{`let top  = tree.best(&reader);       // smallest key (top of book)
let page = tree.scan(&reader, 16);   // first 16 entries in order
let val  = tree.get(&reader, &key);  // one value by key

if let Some((_key, value)) = top {
    let player = Pubkey::try_from(&value[..32]).unwrap(); // decode your value layout
}`}</Code>}
              />
            </section>

            {/* COLD */}
            <section>
              <H id="cold">When a leaf splits</H>
              <P>A hot insert into a full leaf returns error 102. Fall back to the cold path, which splits the leaf and grows the tree; subsequent inserts at that depth go hot again.</P>
              <DualCode
                ts={<Code lang="typescript">{`try {
  await send(await tree.insertFastIx(reader, authority, key, value));
} catch (e) {
  if (isNeedSplit(e)) {
    // cold path: the maker pays spare-node rent; the engine does the split
    await send(await tree.insertIx(reader, payer, key, value, rentNode));
  } else throw e;
}`}</Code>}
                rust={<Code lang="rust">{`// hot insert returns ERR_NEED_SPLIT_SLOT (102) on a full leaf; use the cold split path:
let ix = tree.insert_ix(&reader, payer, &key, &value, rent_node);`}</Code>}
              />
            </section>

            {/* ON-CHAIN */}
            <section>
              <H id="onchain">From your program (CPI)</H>
              <P>When invariants must live on-chain (escrow, access control), your program owns the tree as a PDA authority and CPIs Torna with the <span className="nums text-fg">torna-cpi</span> crate. This is inherently Rust, and exactly how the reference order book inserts and cancels.</P>
              <Code lang="rust">{`use torna_cpi;

// your program signs as the tree-authority PDA; the client resolved \`path\`
let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];

torna_cpi::insert_fast(
    torna_program, // the Torna engine program
    authority,     // your authority PDA
    header,        // the tree header
    path,          // root..leaf accounts (client-resolved)
    &key,
    &value,
    &[seeds],
)?;`}</Code>
            </section>

            {/* FULL EXAMPLE */}
            <section>
              <H id="example">A complete example: a leaderboard</H>
              <P>The whole design is choosing what the key and value mean. Encode the sort field big-endian; add a writer-unique tail so two writers never collide.</P>
              <DualCode
                ts={<Code lang="typescript">{`import { Tree } from "torna-sdk";

const MAX = 2n ** 64n - 1n;

// key = (MAX - score) big-endian, so the highest score sorts first
function scoreKey(score: bigint, player: PublicKey): Uint8Array {
  const k = new Uint8Array(32);
  new DataView(k.buffer).setBigUint64(0, MAX - score, false); // best first
  k.set(player.toBytes().subarray(0, 16), 16);                // unique tail
  return k;
}

const board = new Tree(program, creator, /* treeId */ 7);

// submit a score (value = the player); many players write in parallel
const ix = await board.insertFastIx(reader, authority, scoreKey(score, player), player.toBytes());

// read the top 10, off-chain, no transaction
const top10 = await board.scan(reader, 10);`}</Code>}
                rust={<Code lang="rust">{`use torna_sdk::Tree;
use solana_sdk::pubkey::Pubkey;

// key = (u64::MAX - score) big-endian, so the highest score sorts first
fn score_key(score: u64, player: &Pubkey) -> [u8; 32] {
    let mut k = [0u8; 32];
    k[0..8].copy_from_slice(&(u64::MAX - score).to_be_bytes()); // best first
    k[16..32].copy_from_slice(&player.to_bytes()[0..16]);       // unique tail
    k
}

let board = Tree::new(program, creator, /* tree_id */ 7);

// submit a score (value = the player); many players write in parallel
let ix = board.insert_fast_ix(&reader, authority, &score_key(score, &player), &player.to_bytes());

// read the top 10, off-chain, no transaction
let top10 = board.scan(&reader, 10);`}</Code>}
              />
              <P>Swap the key encoding and you have a liquidation queue (key = health), an expiry queue (key = deadline), or an order book (key = price-time). Same engine, same reads.</P>
            </section>

            {/* ERRORS */}
            <section>
              <H id="errors">Errors and staleness</H>
              <P>Between resolving a path and landing, a concurrent writer may split or merge a node. The engine returns ERR_BAD_PATH; re-resolve from fresh state and retry. The SDK ships a small <span className="nums text-fg">retry</span> helper for this.</P>
              <Code lang="text">{`102  ERR_NEED_SPLIT_SLOT   leaf is full          -> fall back to the cold insert (split)
103  ERR_DUPLICATE_KEY     key already exists
104  ERR_KEY_NOT_FOUND     update/delete on an absent key
105  ERR_BAD_PATH          a concurrent split/merge moved the path -> re-resolve and retry`}</Code>
            </section>

            {/* REFERENCE */}
            <section>
              <H id="reference">Reference</H>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                {[
                  ["torna-sdk on npm (TypeScript)", "https://www.npmjs.com/package/torna-sdk"],
                  ["torna-sdk on crates.io (Rust)", "https://crates.io/crates/torna-sdk"],
                  ["torna-cpi on crates.io (on-chain)", "https://crates.io/crates/torna-cpi"],
                  ["API docs on docs.rs", "https://docs.rs/torna-sdk"],
                  ["The reference order book (real integration)", `${GH}/tree/main/orderbook`],
                  ["Source on GitHub", GH],
                ].map(([label, href]) => (
                  <a key={label} href={href} target="_blank" rel="noreferrer" className="rounded-lg border border-line bg-panel px-4 py-2.5 text-muted transition-colors duration-100 hover:border-brand/40 hover:text-fg">{label}</a>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
                <Link href="/docs" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi">Full docs <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
                <Link href="/trade" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 font-medium text-fg transition-colors duration-100 hover:bg-panel-hi">See it trade live</Link>
                <a href={GH} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 font-medium text-fg transition-colors duration-100 hover:bg-panel-hi"><GithubIcon className="h-3.5 w-3.5" /> GitHub</a>
              </div>
            </section>
          </div>
        </article>
      </LangProvider>
    </div>
  );
}
