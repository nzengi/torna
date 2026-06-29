// Devnet market bring-up. Programs are already deployed (demo/deploy/*-keypair.json). This
// creates the mints + vaults, inits the ask/bid trees, seeds a size-0 sentinel into each,
// transfers tree authority to the book PDA, runs InitMarket, funds a pool of demo identities,
// seeds liquidity, and writes the frontend config (.env.local + src/lib/market.json).
//
// Run from demo/:  npx tsx scripts/bringup.ts
import "../src/lib/polyfill";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { Tree, keys, type AccountReader } from "torna-sdk";
import {
  ASK, BID, bookPda, cfgPda, orderValue, transferAuthorityIx, initMarketIx, placeIx, type Side,
} from "../src/lib/orderbook";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const VS = 8 + 32; // 40: maker(32) + size_be(8)
const F = 8;
const MARKET_ID = 1n;
const ASK_TREE = 1;
const BID_TREE = 2;

const conn = new Connection(RPC, "confirmed");
const here = (p: string) => join(import.meta.dirname, p);
function loadKp(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const reader: AccountReader = {
  async accountData(k: PublicKey) {
    const a = await conn.getAccountInfo(k, "confirmed");
    return a ? Uint8Array.from(a.data) : null;
  },
};
const rent = (n: number) => conn.getMinimumBalanceForRentExemption(n);
async function send(ixs: any[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
function nodeSize(f: number, vs: number): number {
  return Math.max(44 + (f + 1) * 32 + (f + 1) * vs, 44 + (f + 1) * 32 + (f + 2) * 8);
}

async function main() {
  const payer = loadKp(join(homedir(), ".config/solana/id.json"));
  const torna = loadKp(here("../deploy/torna-keypair.json")).publicKey;
  const orderbook = loadKp(here("../deploy/orderbook-keypair.json")).publicKey;
  console.log("payer    ", payer.publicKey.toBase58());
  console.log("torna    ", torna.toBase58());
  console.log("orderbook", orderbook.toBase58());

  const [book, bump] = bookPda(orderbook, MARKET_ID);
  const [cfg] = cfgPda(orderbook, MARKET_ID);
  const ask = new Tree(torna, payer.publicKey, ASK_TREE);
  const bid = new Tree(torna, payer.publicKey, BID_TREE);

  // re-run guard: the tree PDAs are deterministic, so a second run would just waste rent then abort
  // at init_tree. Bail early with a clear message (bump MARKET_ID/tree ids for a fresh market).
  if (await reader.accountData(ask.headerPda()[0])) {
    console.error(`market ${MARKET_ID} already initialized (ask header exists). Bump MARKET_ID/ASK_TREE/BID_TREE for a fresh market. Aborting.`);
    process.exit(1);
  }

  // 1) mints (decimals 0 for clean integer display)
  console.log("creating mints ...");
  const baseMint = await createMint(conn, payer, payer.publicKey, null, 0);
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 0);

  // 2) vaults = the book PDA's ATAs (off-curve owner)
  console.log("creating vaults ...");
  const baseVault = (await getOrCreateAssociatedTokenAccount(conn, payer, baseMint, book, true)).address;
  const quoteVault = (await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, book, true)).address;

  // 3) trees: init, seed a 0-size sentinel (height -> 1), authority -> book PDA
  const rHdr = BigInt(await rent(146));
  const rAlloc = BigInt(await rent(32));
  const rNode = BigInt(await rent(nodeSize(F, VS)));
  for (const [tree, side, sentPrice] of [[ask, ASK, 1_000_000n], [bid, BID, 1n]] as [Tree, Side, bigint][]) {
    console.log(`init tree ${tree.treeId} ...`);
    await send([tree.initTreeIx(payer.publicKey, VS, F, rHdr, rAlloc)], [payer]);
    const sd = side === ASK ? keys.Side.Ask : keys.Side.Bid;
    const sentKey = keys.orderKey(sd, sentPrice, 0n, payer.publicKey, 0n);
    const sentVal = orderValue(payer.publicKey, 0n);
    const cold = await tree.insertIx(reader, payer.publicKey, sentKey, sentVal, rNode);
    if (!cold) throw new Error("sentinel cold insert ix unresolved");
    await send([cold], [payer]);
    await send([transferAuthorityIx(torna, tree.headerPda()[0], payer.publicKey, book)], [payer]);
  }

  // 4) InitMarket
  console.log("init market ...");
  const askRoot = ask.nodePda((await ask.header(reader))!.root)[0];
  const bidRoot = bid.nodePda((await bid.header(reader))!.root)[0];
  await send([initMarketIx({
    orderbook, torna, marketId: MARKET_ID, payer: payer.publicKey,
    baseMint, quoteMint, baseVault, quoteVault,
    askHeader: ask.headerPda()[0], bidHeader: bid.headerPda()[0], askRoot, bidRoot,
    rent: BigInt(await rent(229)),
  })], [payer]);
  const cfgAcct = await conn.getAccountInfo(cfg);
  console.log("market cfg bytes:", cfgAcct?.data.length, "(expect 229)");

  // 5) demo identities: funded with SOL + base/quote tokens
  console.log("funding demo identities ...");
  const demos = Array.from({ length: 4 }, () => Keypair.generate());
  const baseAtaOf: Record<string, PublicKey> = {};
  const quoteAtaOf: Record<string, PublicKey> = {};
  for (const kp of demos) {
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 60_000_000 })], [payer]);
    baseAtaOf[kp.publicKey.toBase58()] = (await getOrCreateAssociatedTokenAccount(conn, payer, baseMint, kp.publicKey)).address;
    quoteAtaOf[kp.publicKey.toBase58()] = (await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, kp.publicKey)).address;
    await mintTo(conn, payer, baseMint, baseAtaOf[kp.publicKey.toBase58()], payer, 1000);
    await mintTo(conn, payer, quoteMint, quoteAtaOf[kp.publicKey.toBase58()], payer, 1_000_000);
  }

  // 6) seed liquidity across price levels (depth for the ladder + the parallelism story)
  console.log("seeding liquidity ...");
  const seed: [number, Side, bigint, bigint][] = [
    [0, ASK, 104n, 5n], [1, ASK, 106n, 8n], [2, ASK, 108n, 6n],
    [0, BID, 98n, 6n], [1, BID, 96n, 4n], [3, BID, 94n, 7n],
  ];
  for (const [mi, side, price, size] of seed) {
    const maker = demos[mi];
    const tree = side === ASK ? ask : bid;
    const src = side === ASK ? baseAtaOf[maker.publicKey.toBase58()] : quoteAtaOf[maker.publicKey.toBase58()];
    const vault = side === ASK ? baseVault : quoteVault;
    const { ix } = await placeIx({
      reader, tree, orderbook, torna, marketId: MARKET_ID,
      side, price, size, nonce: BigInt(mi + 1), maker: maker.publicKey, makerSrc: src, vault,
    });
    await send([ix], [payer, maker]);
    console.log(`  placed ${side === ASK ? "ASK" : "BID"} ${size}@${price} by demo${mi}`);
  }

  // 7) write frontend config. NOTE: market.json is committed/bundled, so it must NOT carry a secret
  // RPC key — write the PUBLIC endpoint here and keep the dedicated key only in .env.local (gitignored,
  // read via NEXT_PUBLIC_RPC_URL). Scripts read process.env.RPC for a dedicated endpoint.
  const market = {
    cluster: "devnet", rpcUrl: "https://api.devnet.solana.com",
    tornaProgramId: torna.toBase58(), orderbookProgramId: orderbook.toBase58(),
    marketId: MARKET_ID.toString(), bookBump: bump,
    creator: payer.publicKey.toBase58(), askTreeId: ASK_TREE, bidTreeId: BID_TREE,
    baseMint: baseMint.toBase58(), quoteMint: quoteMint.toBase58(),
    baseVault: baseVault.toBase58(), quoteVault: quoteVault.toBase58(),
    book: book.toBase58(), cfg: cfg.toBase58(),
    demos: demos.map((k) => ({ pubkey: k.publicKey.toBase58(), secret: Array.from(k.secretKey) })),
  };
  writeFileSync(here("../src/lib/market.json"), JSON.stringify(market, null, 2));
  const env = [
    `NEXT_PUBLIC_RPC_URL=${RPC}`,
    `NEXT_PUBLIC_TORNA_PROGRAM=${torna.toBase58()}`,
    `NEXT_PUBLIC_ORDERBOOK_PROGRAM=${orderbook.toBase58()}`,
    `NEXT_PUBLIC_MARKET_ID=${MARKET_ID}`,
    `NEXT_PUBLIC_CREATOR=${payer.publicKey.toBase58()}`,
    `NEXT_PUBLIC_ASK_TREE_ID=${ASK_TREE}`,
    `NEXT_PUBLIC_BID_TREE_ID=${BID_TREE}`,
    `NEXT_PUBLIC_BASE_MINT=${baseMint.toBase58()}`,
    `NEXT_PUBLIC_QUOTE_MINT=${quoteMint.toBase58()}`,
  ].join("\n") + "\n";
  writeFileSync(here("../.env.local"), env);
  console.log("\nDONE. wrote src/lib/market.json + .env.local");
  console.log("book", book.toBase58(), "cfg", cfg.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
