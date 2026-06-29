// Orderbook key convention (CLOB-specific; the core Tree is key-agnostic).
//
// A 32-byte order key that sorts to price-time priority: asks ascending price, bids
// descending price; ties broken by slot (approximate FIFO), then a (maker[0..8], nonce)
// tail. This is writer-unique for ONE maker varying nonce; two DIFFERENT makers that share
// an 8-byte pubkey prefix at the same price+slot+nonce collide (grindable) -- but a
// collision only triggers an atomic-revert on placement (ERR_DUPLICATE_KEY), and settlement
// and cancel authorize against the FULL 32-byte maker stored in the order VALUE, never the
// key, so a collision can never misroute funds. Strict global FIFO is intentionally NOT used
// -- a shared sequence counter would serialize every placement and destroy the parallelism.
// Mirrors torna_sdk::keys (Rust) byte-for-byte.

import { PublicKey } from "@solana/web3.js";

export enum Side {
  Ask = 0,
  Bid = 1,
}

const U64_MAX = (1n << 64n) - 1n;

// Rust's `u64` makes an out-of-range price/slot/nonce unrepresentable; the TS port has
// no such type guard, and DataView.setBigUint64 SILENTLY WRAPS mod 2^64 -- e.g. an Ask
// priced at 2^64 would encode price 0 (top of book, instant fill). So validate explicitly
// and throw, rather than emit a wrong-but-valid order key. (round-1 footgun #1)
function assertU64(v: bigint, name: string): void {
  if (typeof v !== "bigint") throw new TypeError(`${name} must be a bigint`);
  if (v < 0n || v > U64_MAX) throw new RangeError(`${name} out of u64 range: ${v}`);
}

function writeU64BE(buf: Uint8Array, off: number, v: bigint): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(off, v & U64_MAX, false); // big-endian
}
function readU64BE(buf: Uint8Array, off: number): bigint {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getBigUint64(off, false);
}

/** 32-byte order key: price(8 BE) | slot(8 BE) | maker[0..8] | nonce(8 BE). */
export function orderKey(
  side: Side,
  price: bigint,
  slot: bigint,
  maker: PublicKey,
  nonce: bigint,
): Uint8Array {
  assertU64(price, "price");
  assertU64(slot, "slot");
  assertU64(nonce, "nonce");
  const p = side === Side.Ask ? price : U64_MAX - price;
  const k = new Uint8Array(32);
  writeU64BE(k, 0, p);
  writeU64BE(k, 8, slot);
  k.set(maker.toBytes().subarray(0, 8), 16);
  writeU64BE(k, 24, nonce);
  return k;
}

export function priceOf(side: Side, key: Uint8Array): bigint {
  if (key.length !== 32) throw new RangeError(`order key must be 32 bytes, got ${key.length}`);
  const p = readU64BE(key, 0);
  return side === Side.Ask ? p : U64_MAX - p;
}

export function slotOf(key: Uint8Array): bigint {
  if (key.length !== 32) throw new RangeError(`order key must be 32 bytes, got ${key.length}`);
  return readU64BE(key, 8);
}
