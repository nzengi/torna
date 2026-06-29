// Capture a REAL on-chain transaction as a JSON artifact for the docs: place an order, fetch the
// confirmed tx (CU consumed, fee, logs showing the orderbook -> Torna CPI, account set), save it,
// then cancel to leave the book clean. Run: RPC=<url> npx tsx scripts/capture-tx.ts
import "../src/lib/polyfill";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Tree } from "torna-sdk";
import { ASK, BID, placeIx, cancelIx, bookPda, type Side } from "../src/lib/orderbook";

const M = JSON.parse(readFileSync(join(import.meta.dirname, "../src/lib/market.json"), "utf8"));
const conn = new Connection(process.env.RPC ?? M.rpcUrl, "confirmed");
const reader = { async accountData(k: PublicKey) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const torna = new PublicKey(M.tornaProgramId);
const orderbook = new PublicKey(M.orderbookProgramId);
const askTree = new Tree(torna, new PublicKey(M.creator), M.askTreeId);
const ata = (mint: string, owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);

const bidTree = new Tree(torna, new PublicKey(M.creator), M.bidTreeId);

async function tryPlace(maker: Keypair, side: Side, price: bigint) {
  const tree = side === ASK ? askTree : bidTree;
  const src = side === ASK ? ata(M.baseMint, maker.publicKey) : ata(M.quoteMint, maker.publicKey);
  const vault = new PublicKey(side === ASK ? M.baseVault : M.quoteVault);
  const { ix, key } = await placeIx({
    reader, tree, orderbook, torna, marketId: BigInt(M.marketId),
    side, price, size: 1n, nonce: BigInt(Date.now()), maker: maker.publicKey, makerSrc: src, vault,
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [maker], { commitment: "confirmed" });
  return { sig, key, side, price, tree, vault, src };
}

async function main() {
  const maker = Keypair.fromSecretKey(Uint8Array.from(M.demos[0].secret));
  // try candidates that route to a leaf with room (a full leaf returns ERR_NEED_SPLIT_SLOT)
  const candidates: [Side, bigint][] = [[BID, 50n], [BID, 30n], [BID, 10n], [ASK, 200n], [ASK, 500n], [ASK, 1000n]];
  let placed: Awaited<ReturnType<typeof tryPlace>> | null = null;
  for (const [side, price] of candidates) {
    try { placed = await tryPlace(maker, side, price); break; }
    catch { /* full leaf or transient; try next candidate */ }
  }
  if (!placed) throw new Error("all candidate placements hit full leaves");
  const { sig, key, side, price, tree, vault, src } = placed;
  console.log(`placed ${side === ASK ? "ASK" : "BID"} 1@${price}, tx`, sig);

  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error("tx not found");
  const meta = tx.meta!;
  const msg = tx.transaction.message;
  const keysList = msg.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());

  const artifact = {
    description: "A real PlaceOrder transaction on Solana devnet: the orderbook program escrows base tokens and CPIs into the Torna engine's InsertFast to insert the order into the on-chain B+ tree, atomically.",
    signature: sig,
    cluster: "devnet",
    slot: tx.slot,
    blockTime: tx.blockTime,
    fee_lamports: meta.fee,
    compute_units_consumed: meta.computeUnitsConsumed ?? null,
    status: meta.err ? "failed" : "success",
    instruction: {
      program: orderbook.toBase58(),
      name: "PlaceOrder",
      discriminator: 0,
      side: side === ASK ? "ask" : "bid",
      order_key_hex: Buffer.from(key).toString("hex"),
      escrow: side === ASK ? "1 base token locked in the base vault" : `${price} quote tokens locked in the quote vault`,
    },
    accounts: keysList,
    program_log: meta.logMessages ?? [],
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  };

  mkdirSync(join(import.meta.dirname, "../public"), { recursive: true });
  writeFileSync(join(import.meta.dirname, "../public/sample-place-tx.json"), JSON.stringify(artifact, null, 2));
  console.log("\nsaved public/sample-place-tx.json");
  console.log("CU consumed:", artifact.compute_units_consumed, "| fee:", meta.fee, "| accounts:", keysList.length);
  console.log("logs (CPI evidence):");
  (meta.logMessages ?? []).slice(0, 10).forEach((l) => console.log("  " + l));

  // cleanup: cancel the order we just placed
  const cix = await cancelIx({
    reader, tree, orderbook, torna, marketId: BigInt(M.marketId),
    side, key, maker: maker.publicKey, vault, makerDst: src,
  });
  const csig = await sendAndConfirmTransaction(conn, new Transaction().add(cix), [maker], { commitment: "confirmed" });
  console.log("\ncleaned up (cancelled), tx", csig.slice(0, 16), "...");
}
main().catch((e) => { console.error(e); process.exit(1); });
