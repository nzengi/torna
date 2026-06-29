// Validate the Take (match) path the UI uses: a taker buys against the ASK book, tokens settle
// atomically, the filled order shrinks. Small fill (limit 104, size 2) to barely disturb the book.
// Run: npx tsx scripts/smoke-match.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Tree, keys, type AccountReader } from "torna-sdk";
import { ASK, matchIx } from "../src/lib/orderbook";

const M = JSON.parse(readFileSync(join(import.meta.dirname, "../src/lib/market.json"), "utf8"));
const conn = new Connection(process.env.RPC ?? M.rpcUrl, "confirmed");
const reader: AccountReader = { async accountData(k: PublicKey) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const torna = new PublicKey(M.tornaProgramId);
const orderbook = new PublicKey(M.orderbookProgramId);
const askTree = new Tree(torna, new PublicKey(M.creator), M.askTreeId);
const ata = (mint: string, owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);

async function bal(a: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(a, "confirmed");
  return info ? new DataView(Uint8Array.from(info.data).buffer).getBigUint64(64, true) : 0n;
}
async function asks() {
  return (await askTree.scan(reader, 64))
    .map((e) => ({ price: keys.priceOf(keys.Side.Ask, e.key), size: new DataView(e.value.buffer, e.value.byteOffset).getBigUint64(32, false) }))
    .filter((o) => o.size > 0n);
}

async function main() {
  const taker = Keypair.fromSecretKey(Uint8Array.from(M.demos[3].secret)); // demo3 has no asks -> no self-trade
  const LIMIT = 104n, SIZE = 2n;
  const takerBaseAta = ata(M.baseMint, taker.publicKey);
  const takerQuoteAta = ata(M.quoteMint, taker.publicKey);

  const before = await asks();
  console.log("asks before:", before.map((o) => `${o.size}@${o.price}`).join(", "));
  const [tB0, tQ0] = [await bal(takerBaseAta), await bal(takerQuoteAta)];

  const built = await matchIx({
    reader, tree: askTree, orderbook, torna, marketId: BigInt(M.marketId),
    bookSide: ASK, limit: LIMIT, size: SIZE, maxFills: 8,
    taker: taker.publicKey, vault: new PublicKey(M.baseVault),
    takerRecv: takerBaseAta, takerPay: takerQuoteAta, payMint: new PublicKey(M.quoteMint),
  });
  if (!built) { console.log("no crossing orders — FAIL"); process.exit(1); }
  console.log("fills:", built.fills.map((f) => `${f.fill}@${f.price} from ${f.maker.toBase58().slice(0, 4)}…`).join(", "));
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(built.ix), [taker], { commitment: "confirmed" });
  console.log("MATCH tx", sig.slice(0, 16), "…");

  const after = await asks();
  const [tB1, tQ1] = [await bal(takerBaseAta), await bal(takerQuoteAta)];
  console.log("asks after: ", after.map((o) => `${o.size}@${o.price}`).join(", "));
  const cost = built.fills.reduce((s, f) => s + f.price * f.fill, 0n);
  const got = built.fills.reduce((s, f) => s + f.fill, 0n);
  const baseOk = tB1 - tB0 === got;
  const quoteOk = tQ0 - tQ1 === cost;
  console.log(`taker base +${tB1 - tB0} (expect +${got}) ${baseOk ? "OK" : "FAIL"}; taker quote -${tQ0 - tQ1} (expect -${cost}) ${quoteOk ? "OK" : "FAIL"}`);
  console.log(baseOk && quoteOk ? "\nSMOKE PASS: match settles tokens + mutates the book" : "\nSMOKE FAIL");
  if (!(baseOk && quoteOk)) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
