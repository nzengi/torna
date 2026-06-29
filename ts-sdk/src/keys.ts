// Orderbook key convention (CLOB-specific; the core Tree is key-agnostic).
//
// A 32-byte order key that sorts to price-time priority: asks ascending price, bids
// descending price; ties broken by slot (approximate FIFO), then a WRITER-UNIQUE
// (maker, nonce) tail so two parallel makers never collide on a key. Strict global
// FIFO is intentionally NOT used -- a shared sequence counter would serialize every
// placement and destroy the parallelism. Mirrors torna_sdk::keys (Rust) byte-for-byte.

import { PublicKey } from "@solana/web3.js";

export enum Side {
  Ask = 0,
  Bid = 1,
}

const U64_MAX = (1n << 64n) - 1n;

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
  const p = side === Side.Ask ? price : U64_MAX - price;
  const k = new Uint8Array(32);
  writeU64BE(k, 0, p);
  writeU64BE(k, 8, slot);
  k.set(maker.toBytes().subarray(0, 8), 16);
  writeU64BE(k, 24, nonce);
  return k;
}

export function priceOf(side: Side, key: Uint8Array): bigint {
  const p = readU64BE(key, 0);
  return side === Side.Ask ? p : U64_MAX - p;
}

export function slotOf(key: Uint8Array): bigint {
  return readU64BE(key, 8);
}
