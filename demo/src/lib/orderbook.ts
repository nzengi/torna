// TS client for the reference orderbook program (mirrors orderbook/src/lib.rs byte-for-byte;
// the proven oracle is integration/obtest.rs). The frontend AND the bring-up script use these
// builders. Path/spare resolution is delegated to torna-sdk; this layer adds the escrow CLOB
// instruction wire formats + the off-chain fill computation a taker needs for a match.
import "./polyfill";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Tree, keys, type AccountReader } from "torna-sdk";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// orderbook discriminators
const PLACE = 0;
const CANCEL = 1;
const MATCH = 2;
const PLACE_COLD = 3;
const INIT_MARKET = 4;
// torna engine discriminator used at setup
const TRANSFER_AUTHORITY = 11;

export const ASK = 0;
export const BID = 1;
export type Side = typeof ASK | typeof BID;

// torna node layout (mirrors abi.md)
const NODE_HDR = 44;
const N_KEY_COUNT = 2;
const N_NEXT_LEAF = 20;
const KEY_SIZE = 32;

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
function concat(parts: Uint8Array[]): Buffer {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}
function rdU16(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
}
function rdU64le(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}
function rdU64be(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, false);
}
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

// ---- market PDAs ----
export function bookPda(orderbook: PublicKey, marketId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("book"), u64le(marketId)], orderbook);
}
export function cfgPda(orderbook: PublicKey, marketId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("mkt"), u64le(marketId)], orderbook);
}

/** Order value (40B): maker(32) | size_be(8). The SDK is value-agnostic; this is CLOB-specific. */
export function orderValue(maker: PublicKey, size: bigint): Uint8Array {
  const v = new Uint8Array(40);
  v.set(maker.toBytes(), 0);
  new DataView(v.buffer).setBigUint64(32, size, false); // big-endian
  return v;
}

export const sideEnum = (side: Side) => (side === ASK ? keys.Side.Ask : keys.Side.Bid);

// ---- setup instructions (used by the bring-up) ----

/** Torna TransferAuthority (disc 11): hand a tree's write authority to the book PDA. */
export function transferAuthorityIx(
  torna: PublicKey, headerPda: PublicKey, currentAuthority: PublicKey, newAuthority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: torna,
    data: concat([Uint8Array.of(TRANSFER_AUTHORITY), newAuthority.toBytes()]),
    keys: [m(headerPda, false, true), m(currentAuthority, true, false)],
  });
}

/** InitMarket (disc 4): write + bind the market config PDA. */
export function initMarketIx(args: {
  orderbook: PublicKey; torna: PublicKey; marketId: bigint; payer: PublicKey;
  baseMint: PublicKey; quoteMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey;
  askHeader: PublicKey; bidHeader: PublicKey; askRoot: PublicKey; bidRoot: PublicKey; rent: bigint;
}): TransactionInstruction {
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg, cfgBump] = cfgPda(args.orderbook, args.marketId);
  const data = concat([
    Uint8Array.of(INIT_MARKET), u64le(args.marketId),
    Uint8Array.of(bump), Uint8Array.of(cfgBump), u64le(args.rent),
  ]);
  return new TransactionInstruction({
    programId: args.orderbook,
    data,
    keys: [
      m(args.payer, true, true), m(cfg, false, true), m(book, false, false),
      m(args.baseMint, false, false), m(args.quoteMint, false, false),
      m(args.baseVault, false, false), m(args.quoteVault, false, false),
      m(SystemProgram.programId, false, false),
      m(args.torna, false, false), m(args.askHeader, false, false), m(args.bidHeader, false, false),
      m(args.askRoot, false, false), m(args.bidRoot, false, false),
    ],
  });
}

// ---- trading instructions (used by the frontend) ----

/** PlaceOrder (disc 0, hot path InsertFast). Escrows base (ASK) or quote (BID), inserts. */
export async function placeIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  side: Side; price: bigint; size: bigint; nonce: bigint; slot?: bigint;
  maker: PublicKey; makerSrc: PublicKey; vault: PublicKey;
}): Promise<{ ix: TransactionInstruction; key: Uint8Array }> {
  const slot = args.slot ?? 0n;
  const key = keys.orderKey(sideEnum(args.side), args.price, slot, args.maker, args.nonce);
  const path = await args.tree.path(args.reader, key);
  if (!path) throw new Error("tree not initialized / path unresolved");
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const data = concat([
    Uint8Array.of(PLACE, args.side), u64le(args.price), u64le(args.size),
    u64le(slot), u64le(args.nonce), u64le(args.marketId), Uint8Array.of(bump),
  ]);
  const meta: AccountMeta[] = [
    m(args.maker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, false),
    m(args.makerSrc, false, true), m(args.vault, false, true), m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    ...path.map((n, i) => m(args.tree.nodePda(n)[0], false, i === path.length - 1)),
  ];
  return { ix: new TransactionInstruction({ programId: args.orderbook, data, keys: meta }), key };
}

/** PlaceOrderCold (disc 3): place into a FULL leaf via the cold Insert path (split). Same escrow as
 *  the hot place; resolves the descent path + spare node PDAs via the SDK cold plan. The maker signs
 *  and pays spare rent; the book PDA authorizes the engine Insert. Mirrors orderbook::place_cold. */
export async function placeColdIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  side: Side; price: bigint; size: bigint; nonce: bigint; slot?: bigint;
  maker: PublicKey; makerSrc: PublicKey; vault: PublicKey; rentNode: bigint;
}): Promise<{ ix: TransactionInstruction; key: Uint8Array } | null> {
  const slot = args.slot ?? 0n;
  const key = keys.orderKey(sideEnum(args.side), args.price, slot, args.maker, args.nonce);
  const plan = await args.tree.coldPlan(args.reader, key);
  if (!plan) return null;
  const { path, spares } = plan; // path: bigint[] (root..leaf); spares: [PublicKey, bump][] (height+2)
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const alloc = args.tree.allocPda()[0];
  const data = concat([
    Uint8Array.of(PLACE_COLD, args.side), u64le(args.price), u64le(args.size),
    u64le(slot), u64le(args.nonce), u64le(args.marketId), Uint8Array.of(bump),
    Uint8Array.of(path.length), Uint8Array.of(spares.length), u64le(args.rentNode),
    Uint8Array.from(spares.map(([, b]) => b)),
  ]);
  const meta: AccountMeta[] = [
    m(args.maker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, true),
    m(args.makerSrc, false, true), m(args.vault, false, true), m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    m(alloc, false, true), m(SystemProgram.programId, false, false),
    ...path.map((n) => m(args.tree.nodePda(n)[0], false, true)),
    ...spares.map(([pk]) => m(pk, false, true)),
  ];
  return { ix: new TransactionInstruction({ programId: args.orderbook, data, keys: meta }), key };
}

/** CancelOrder (disc 1): refund the escrow + remove the order. */
export async function cancelIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  side: Side; key: Uint8Array; maker: PublicKey; vault: PublicKey; makerDst: PublicKey;
}): Promise<TransactionInstruction> {
  const path = await args.tree.path(args.reader, args.key);
  if (!path) throw new Error("path unresolved");
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const data = concat([
    Uint8Array.of(CANCEL), args.key, Uint8Array.of(args.side), u64le(args.marketId), Uint8Array.of(bump),
  ]);
  const meta: AccountMeta[] = [
    m(args.maker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, false),
    m(args.vault, false, true), m(args.makerDst, false, true), m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    ...path.map((n, i) => m(args.tree.nodePda(n)[0], false, i === path.length - 1)),
  ];
  return new TransactionInstruction({ programId: args.orderbook, data, keys: meta });
}

export interface Fill { maker: PublicKey; price: bigint; fill: bigint; key: Uint8Array; leafIdx: bigint; }

/** Walk the book from leftmost (best) and compute the fills a taker at `limit`/`size` would get,
 *  mirroring the on-chain matcher's sweep (price-crossing, sentinel-skipping, leaf-chained). */
export async function computeFills(args: {
  reader: AccountReader; tree: Tree; bookSide: Side; limit: bigint; size: bigint; maxFills: number;
}): Promise<{ fills: Fill[]; leaves: bigint[]; height: number }> {
  const h = await args.tree.header(args.reader);
  if (!h || h.height === 0) return { fills: [], leaves: [], height: 0 };
  const voff = NODE_HDR + (h.fanout + 1) * KEY_SIZE;
  let idx = h.leftmost;
  let remaining = args.size;
  const fills: Fill[] = [];
  const leaves: bigint[] = [];
  outer: while (idx !== 0n && remaining > 0n && fills.length < args.maxFills) {
    const d = await args.reader.accountData(args.tree.nodePda(idx)[0]);
    if (!d) break;
    const cnt = rdU16(d, N_KEY_COUNT);
    let used = false;
    for (let i = 0; i < cnt && remaining > 0n && fills.length < args.maxFills; i++) {
      const key = d.slice(NODE_HDR + i * KEY_SIZE, NODE_HDR + i * KEY_SIZE + KEY_SIZE);
      const price = keys.priceOf(sideEnum(args.bookSide), key);
      const cross = args.bookSide === ASK ? price <= args.limit : price >= args.limit;
      if (!cross) break outer; // globally sorted -> first non-crosser ends it
      const vo = voff + i * h.valueSize;
      const resting = rdU64be(d, vo + 32);
      if (resting === 0n) continue; // sentinel / empty slot
      const fill = remaining < resting ? remaining : resting;
      const maker = new PublicKey(d.slice(vo, vo + 32));
      fills.push({ maker, price, fill, key, leafIdx: idx });
      remaining -= fill;
      used = true;
    }
    if (used) leaves.push(idx);
    idx = rdU64le(d, N_NEXT_LEAF);
  }
  return { fills, leaves, height: h.height };
}

/** Match (disc 2): a taker sweeps the crossing side, settling tokens atomically. Computes the
 *  fills off-chain, derives each maker's pay-mint ATA, and assembles the K-order match tx. */
export async function matchIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  bookSide: Side; limit: bigint; size: bigint; maxFills: number;
  taker: PublicKey; vault: PublicKey; takerRecv: PublicKey; takerPay: PublicKey; payMint: PublicKey;
}): Promise<{ ix: TransactionInstruction; fills: Fill[] } | null> {
  const { fills, leaves, height } = await computeFills(args);
  if (fills.length === 0) return null;
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const nf = fills.length; // max_fills == actual fills so the leaf groups align at base = 9 + nf
  const data = concat([
    Uint8Array.of(MATCH, args.bookSide), u64le(args.limit), u64le(args.size),
    Uint8Array.of(nf), u64le(args.marketId), Uint8Array.of(bump),
    Uint8Array.of(leaves.length), Uint8Array.of(height),
  ]);
  const makerRecvs = fills.map((f) => m(getAssociatedTokenAddressSync(args.payMint, f.maker, true), false, true));
  // each swept leaf contributes its root..leaf path (height accounts), leftmost-first
  const groups: AccountMeta[] = [];
  for (const leaf of leaves) {
    let path: bigint[];
    if (height === 1) {
      path = [leaf];
    } else {
      const firstKey = await firstKeyOfLeaf(args.reader, args.tree, leaf);
      const p = firstKey ? await args.tree.path(args.reader, firstKey) : null;
      if (!p) return null;
      path = p;
    }
    path.forEach((n, i) => groups.push(m(args.tree.nodePda(n)[0], false, i === path.length - 1)));
  }
  const meta: AccountMeta[] = [
    m(args.taker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, false),
    m(args.vault, false, true), m(args.takerRecv, false, true), m(args.takerPay, false, true),
    m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    ...makerRecvs, ...groups,
  ];
  return { ix: new TransactionInstruction({ programId: args.orderbook, data, keys: meta }), fills };
}

async function firstKeyOfLeaf(reader: AccountReader, tree: Tree, leafIdx: bigint): Promise<Uint8Array | null> {
  const d = await reader.accountData(tree.nodePda(leafIdx)[0]);
  if (!d) return null;
  const cnt = rdU16(d, N_KEY_COUNT);
  if (cnt === 0) return null;
  return d.slice(NODE_HDR, NODE_HDR + KEY_SIZE);
}
