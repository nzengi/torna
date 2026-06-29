// Torna client SDK (TypeScript) -- the PathPlanner.
//
// Integrators call insert/update/delete/find with a 32-byte key; the planner reads the
// tree off-chain (via an AccountReader) and produces a ready TransactionInstruction with
// the exact account set. node_idx, bumps, paths, and spares never leak out.
//
// Mirrors the Rust torna-sdk and the FROZEN ABI (torna_docs/abi.md) byte-for-byte. The
// golden-vector + bankrun e2e tests assert equivalence against the Rust SDK and the real
// engine (torna.so).

import {
  PublicKey,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

export * as keys from "./keys.js";

// ---- instruction discriminators ----
export const IX_INIT_TREE = 0;
export const IX_INSERT = 2;
export const IX_FIND = 3;
export const IX_DELETE = 8;
export const IX_INSERT_FAST = 16;
export const IX_UPDATE_FAST = 17;
export const IX_DELETE_FAST = 18;

// engine error codes a client classifies for retry/fallback (see torna.c)
export const ERR_NEED_SPLIT_SLOT = 102; // InsertFast hit a full leaf -> use insert (cold)
export const ERR_DUPLICATE_KEY = 103;
export const ERR_KEY_NOT_FOUND = 104;
export const ERR_BAD_PATH = 105; // node_idx/tree_uid mismatch -> path went stale, re-resolve

// ---- frozen layout (abi.md) ----
export const KEY_SIZE = 32;
export const NODE_HDR = 44;
export const TREE_HEADER_SIZE = 146;
export const ALLOC_SIZE = 32;

// header field offsets
const H_VALUE_SIZE = 46;
const H_FANOUT = 48;
const H_NODE_SIZE = 50;
const H_ROOT = 54;
const H_HEIGHT = 62;
const H_LEFTMOST = 66;
const H_RIGHTMOST = 74;
const H_EPOCH = 82;
const H_AUTHORITY = 90;
// node field offsets
const N_KEY_COUNT = 2;
const N_NODE_IDX = 12;
const N_NEXT_LEAF = 20;
// allocator
const A_HIGH_WATER = 8;

const SYSTEM_PROGRAM = PublicKey.default; // all-zeros == the system program

function dv(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}
function rdU16(d: Uint8Array, o: number): number {
  return dv(d).getUint16(o, true);
}
function rdU32(d: Uint8Array, o: number): number {
  return dv(d).getUint32(o, true);
}
function rdU64(d: Uint8Array, o: number): bigint {
  return dv(d).getBigUint64(o, true);
}
// Rust's u16/u32/u64 types make an out-of-range or non-integer field unrepresentable;
// the TS port has no such guard and DataView.setUintXX/setBigUint64 SILENTLY WRAP
// (e.g. treeId 2^32 -> seed bytes of tree 0 -> instructions target the wrong tree).
// So every narrowing encoder validates its input and throws. (round-1 footgun #2/#3/#5)
function assertUint(v: number, bits: number, name: string): void {
  if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer, got ${v}`);
  if (v < 0 || v > 2 ** bits - 1) throw new RangeError(`${name} out of u${bits} range: ${v}`);
}
function u16le(v: number): Uint8Array {
  assertUint(v, 16, "u16");
  const b = new Uint8Array(2);
  dv(b).setUint16(0, v, true);
  return b;
}
function u32le(v: number): Uint8Array {
  assertUint(v, 32, "u32");
  const b = new Uint8Array(4);
  dv(b).setUint32(0, v, true);
  return b;
}
function u64le(v: bigint): Uint8Array {
  if (typeof v !== "bigint") throw new TypeError(`u64 must be a bigint, got ${typeof v}`);
  if (v < 0n || v > (1n << 64n) - 1n) throw new RangeError(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  dv(b).setBigUint64(0, v, true);
  return b;
}
// The engine's KEY_SIZE is fixed at 32 (Rust takes `&[u8; 32]`). A wrong-length key here
// would mis-route the descent (cmp compares only the shared prefix) AND shift the trailing
// length byte in the instruction data -- a wrong-but-valid tx. Validate at the choke point.
function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_SIZE) throw new RangeError(`key must be ${KEY_SIZE} bytes, got ${key.length}`);
}
function concat(parts: Uint8Array[]): Buffer {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return Buffer.from(out);
}
// lexicographic byte comparison (matches the engine's memcmp key ordering)
function cmp(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Anything that can fetch raw account data (RPC, bankrun, a cache). */
export interface AccountReader {
  accountData(key: PublicKey): Promise<Uint8Array | null>;
}

/** Parsed, cache-relevant header fields. */
export interface Header {
  valueSize: number;
  fanout: number;
  nodeSize: number;
  root: bigint;
  height: number;
  leftmost: bigint;
  rightmost: bigint;
  /** bumped ONLY on a structural change (split/merge/root). Stable between resolve and
   *  submit => the cached path is still valid; a change => re-resolve. */
  structureEpoch: bigint;
  authority: PublicKey;
}

function parseHeader(d: Uint8Array): Header {
  return {
    valueSize: rdU16(d, H_VALUE_SIZE),
    fanout: rdU16(d, H_FANOUT),
    nodeSize: rdU32(d, H_NODE_SIZE),
    root: rdU64(d, H_ROOT),
    height: rdU32(d, H_HEIGHT),
    leftmost: rdU64(d, H_LEFTMOST),
    rightmost: rdU64(d, H_RIGHTMOST),
    structureEpoch: rdU64(d, H_EPOCH),
    authority: new PublicKey(d.subarray(H_AUTHORITY, H_AUTHORITY + 32)),
  };
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

/** A handle to one tree: (program, creator, treeId). All PDA/seed logic lives here. */
export class Tree {
  constructor(
    readonly program: PublicKey,
    readonly creator: PublicKey,
    readonly treeId: number,
  ) {
    assertUint(treeId, 32, "treeId"); // u32 in Rust; reject silent truncation in the PDA seeds
  }

  headerPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("thdr"), this.creator.toBuffer(), u32le(this.treeId)],
      this.program,
    );
  }
  allocPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("talloc"), this.creator.toBuffer(), u32le(this.treeId)],
      this.program,
    );
  }
  nodePda(idx: bigint): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("tnode"), this.creator.toBuffer(), u32le(this.treeId), u64le(idx)],
      this.program,
    );
  }

  async header(r: AccountReader): Promise<Header | null> {
    const d = await r.accountData(this.headerPda()[0]);
    return d ? parseHeader(d) : null;
  }
  private async highWater(r: AccountReader): Promise<bigint | null> {
    const d = await r.accountData(this.allocPda()[0]);
    return d ? rdU64(d, A_HIGH_WATER) : null;
  }

  /** Descent path root..leaf (node_idx list) for `key`. Empty if the tree is empty.
   *  Mirrors the engine's descent: lower_bound, then "key == separator -> go right". */
  async path(r: AccountReader, key: Uint8Array): Promise<bigint[] | null> {
    assertKey(key); // single choke point: every key-taking builder/read resolves a path first
    const h = await this.header(r);
    if (!h) return null;
    if (h.height === 0) return [];
    const f = h.fanout;
    const kidsOff = NODE_HDR + (f + 1) * KEY_SIZE;
    let cur = h.root;
    const path = [cur];
    for (let lvl = 0; lvl < h.height - 1; lvl++) {
      const d = await r.accountData(this.nodePda(cur)[0]);
      if (!d) return null;
      const cnt = rdU16(d, N_KEY_COUNT);
      // lower_bound: first i with keys[i] >= key
      let lo = 0;
      let hi = cnt;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        const mk = d.subarray(NODE_HDR + m * KEY_SIZE, NODE_HDR + m * KEY_SIZE + KEY_SIZE);
        if (cmp(mk, key) < 0) lo = m + 1;
        else hi = m;
      }
      const eq =
        lo < cnt &&
        cmp(d.subarray(NODE_HDR + lo * KEY_SIZE, NODE_HDR + lo * KEY_SIZE + KEY_SIZE), key) === 0;
      const slot = eq ? lo + 1 : lo;
      cur = rdU64(d, kidsOff + slot * 8);
      path.push(cur);
    }
    return path;
  }

  private pathMetas(path: bigint[], leafWritable: boolean): AccountMeta[] {
    return path.map((n, i) => {
      const pk = this.nodePda(n)[0];
      return leafWritable && i === path.length - 1
        ? meta(pk, false, true)
        : meta(pk, false, false);
    });
  }

  // ---- hot path: header read-only, only the leaf writable (parallelizable) ----

  /** InsertFast: place a new key/value into an existing leaf (fails if the leaf is full
   *  -> caller falls back to insertIx for the cold split path). */
  async insertFastIx(
    r: AccountReader,
    authority: PublicKey,
    key: Uint8Array,
    value: Uint8Array,
  ): Promise<TransactionInstruction | null> {
    const path = await this.path(r, key);
    if (!path) return null;
    const data = concat([Uint8Array.of(IX_INSERT_FAST), key, value, Uint8Array.of(path.length)]);
    return this.fastIx(authority, data, path);
  }
  /** UpdateFast: overwrite the value of an existing key in place. */
  async updateFastIx(
    r: AccountReader,
    authority: PublicKey,
    key: Uint8Array,
    value: Uint8Array,
  ): Promise<TransactionInstruction | null> {
    const path = await this.path(r, key);
    if (!path) return null;
    const data = concat([Uint8Array.of(IX_UPDATE_FAST), key, value, Uint8Array.of(path.length)]);
    return this.fastIx(authority, data, path);
  }
  /** DeleteFast: remove a key without rebalancing (a leaf may drop below MIN). */
  async deleteFastIx(
    r: AccountReader,
    authority: PublicKey,
    key: Uint8Array,
  ): Promise<TransactionInstruction | null> {
    const path = await this.path(r, key);
    if (!path) return null;
    const data = concat([Uint8Array.of(IX_DELETE_FAST), key, Uint8Array.of(path.length)]);
    return this.fastIx(authority, data, path);
  }
  private fastIx(authority: PublicKey, data: Buffer, path: bigint[]): TransactionInstruction {
    const keys = [
      meta(this.headerPda()[0], false, false),
      meta(authority, true, false),
      ...this.pathMetas(path, true),
    ];
    return new TransactionInstruction({ keys, programId: this.program, data });
  }

  /** Find: returns the instruction; the caller reads return_data [found u8, value..]. */
  async findIx(r: AccountReader, key: Uint8Array): Promise<TransactionInstruction | null> {
    const path = await this.path(r, key);
    if (!path) return null;
    const data = concat([Uint8Array.of(IX_FIND), key, Uint8Array.of(path.length)]);
    const keys = [meta(this.headerPda()[0], false, false), ...this.pathMetas(path, false)];
    return new TransactionInstruction({ keys, programId: this.program, data });
  }

  // ---- cold path: Insert (descends, may split via CPI-created spares) ----

  /** Insert (cold path): handles the empty-tree first insert and splits. Resolves the
   *  spare node PDAs (height+2) the engine may need. `rentNode` = rent-exempt lamports
   *  for one node account. */
  async insertIx(
    r: AccountReader,
    payer: PublicKey,
    key: Uint8Array,
    value: Uint8Array,
    rentNode: bigint,
  ): Promise<TransactionInstruction | null> {
    const h = await this.header(r);
    if (!h) return null;
    const hw = await this.highWater(r);
    if (hw === null) return null;
    const path = await this.path(r, key);
    if (!path) return null;
    const spareN = h.height + 2;
    const parts: Uint8Array[] = [
      Uint8Array.of(IX_INSERT),
      key,
      value,
      Uint8Array.of(path.length),
      Uint8Array.of(spareN),
      u64le(rentNode),
    ];
    const spares: PublicKey[] = [];
    for (let i = 0n; i < BigInt(spareN); i++) {
      const [pk, b] = this.nodePda(hw + 1n + i);
      parts.push(Uint8Array.of(b));
      spares.push(pk);
    }
    const keys = [
      meta(this.headerPda()[0], false, true),
      meta(payer, true, true),
      meta(this.allocPda()[0], false, true),
      meta(SYSTEM_PROGRAM, false, false),
      ...path.map((n) => meta(this.nodePda(n)[0], false, true)),
      ...spares.map((s) => meta(s, false, true)),
    ];
    return new TransactionInstruction({ keys, programId: this.program, data: concat(parts) });
  }

  /** Delete (cold path): removes a key and rebalances (borrow/merge), reclaiming rent to
   *  `payer`. Resolves, per non-root level, which sibling the engine needs (right if our
   *  child is not the last, else left). `payer` must be the tree authority. */
  async deleteIx(
    r: AccountReader,
    payer: PublicKey,
    key: Uint8Array,
  ): Promise<TransactionInstruction | null> {
    const h = await this.header(r);
    if (!h || h.height === 0) return null;
    const path = await this.path(r, key);
    if (!path) return null;
    const height = path.length;
    const ko = NODE_HDR + (h.fanout + 1) * KEY_SIZE;
    const sides = new Uint8Array(height);
    const sibIdxs: bigint[] = [];
    for (let level = 1; level < height; level++) {
      const nodeIdx = path[level];
      const pd = await r.accountData(this.nodePda(path[level - 1])[0]);
      if (!pd) return null;
      const pcnt = rdU16(pd, N_KEY_COUNT);
      const kid = (i: number) => rdU64(pd, ko + i * 8);
      let our = -1;
      for (let i = 0; i <= pcnt; i++) {
        if (kid(i) === nodeIdx) {
          our = i;
          break;
        }
      }
      // Child not under this parent (stale path), or a degenerate 0-separator parent: bail
      // with null so the caller re-resolves, rather than read a garbage offset (kid(-1) =>
      // an out-of-place but in-bounds slice) and emit a wrong sibling account. Unreachable
      // with valid, consistent on-chain state (then our is found and pcnt >= 1).
      if (our < 0) return null;
      if (our < pcnt) {
        sides[level] = 1;
        sibIdxs.push(kid(our + 1)); // not the last child -> right sibling
      } else if (our > 0) {
        sides[level] = 2;
        sibIdxs.push(kid(our - 1)); // last child (pcnt >= 1) -> left sibling
      } else {
        return null; // last child but parent has no separators -> no sibling exists
      }
    }
    const data = concat([Uint8Array.of(IX_DELETE), key, Uint8Array.of(height), sides]);
    const keys = [
      meta(this.headerPda()[0], false, true),
      meta(payer, true, true),
      ...path.map((n) => meta(this.nodePda(n)[0], false, true)),
      ...sibIdxs.map((s) => meta(this.nodePda(s)[0], false, true)),
    ];
    return new TransactionInstruction({ keys, programId: this.program, data });
  }

  /** Resolve the cold-path Insert plan for `key`: the descent path and the spare node PDAs
   *  (height+2, with bumps) the engine may consume on a split. Used to build a cold place
   *  when InsertFast hits a full leaf (ERR_NEED_SPLIT_SLOT). */
  async coldPlan(
    r: AccountReader,
    key: Uint8Array,
  ): Promise<{ path: bigint[]; spares: [PublicKey, number][] } | null> {
    const h = await this.header(r);
    if (!h) return null;
    const hw = await this.highWater(r);
    if (hw === null) return null;
    const path = await this.path(r, key);
    if (!path) return null;
    const spareN = BigInt(h.height + 2);
    const spares: [PublicKey, number][] = [];
    for (let i = 0n; i < spareN; i++) spares.push(this.nodePda(hw + 1n + i));
    return { path, spares };
  }

  /** InitTree. `rentHdr`/`rentAlloc` from the caller's client. */
  initTreeIx(
    payer: PublicKey,
    valueSize: number,
    fanout: number,
    rentHdr: bigint,
    rentAlloc: bigint,
  ): TransactionInstruction {
    const [hdr, hb] = this.headerPda();
    const [alc, ab] = this.allocPda();
    const data = concat([
      Uint8Array.of(IX_INIT_TREE),
      u32le(this.treeId),
      Uint8Array.of(hb),
      Uint8Array.of(ab),
      u16le(valueSize),
      u16le(fanout),
      u64le(rentHdr),
      u64le(rentAlloc),
    ]);
    const keys = [
      meta(payer, true, true),
      meta(hdr, false, true),
      meta(alc, false, true),
      meta(SYSTEM_PROGRAM, false, false),
    ];
    return new TransactionInstruction({ keys, programId: this.program, data });
  }

  // ---- client-side reads (walk the tree off-chain; no transaction needed) ----

  /** In-order scan from the smallest key, up to `max` entries: {key, value} pairs. Walks
   *  the forward leaf chain. For an orderbook this is the book in price-time order (best
   *  first); take 1 = top of book. */
  async scan(r: AccountReader, max: number): Promise<{ key: Uint8Array; value: Uint8Array }[]> {
    const h = await this.header(r);
    if (!h || h.height === 0) return [];
    const f = h.fanout;
    const vs = h.valueSize;
    const voff = NODE_HDR + (f + 1) * KEY_SIZE;
    let idx = h.leftmost;
    const out: { key: Uint8Array; value: Uint8Array }[] = [];
    while (idx !== 0n && out.length < max) {
      const d = await r.accountData(this.nodePda(idx)[0]);
      if (!d) break;
      const cnt = rdU16(d, N_KEY_COUNT);
      for (let i = 0; i < cnt && out.length < max; i++) {
        const key = d.slice(NODE_HDR + i * KEY_SIZE, NODE_HDR + i * KEY_SIZE + KEY_SIZE);
        const value = d.slice(voff + i * vs, voff + i * vs + vs);
        out.push({ key, value });
      }
      idx = rdU64(d, N_NEXT_LEAF);
    }
    return out;
  }

  /** The smallest entry (top of book), or null if empty. */
  async best(r: AccountReader): Promise<{ key: Uint8Array; value: Uint8Array } | null> {
    return (await this.scan(r, 1))[0] ?? null;
  }

  /** The value stored at `key`, or null if absent. */
  async get(r: AccountReader, key: Uint8Array): Promise<Uint8Array | null> {
    const h = await this.header(r);
    if (!h || h.height === 0) return null;
    const path = await this.path(r, key);
    if (!path || path.length === 0) return null;
    const leaf = path[path.length - 1];
    const d = await r.accountData(this.nodePda(leaf)[0]);
    if (!d) return null;
    const f = h.fanout;
    const vs = h.valueSize;
    const cnt = rdU16(d, N_KEY_COUNT);
    let lo = 0;
    let hi = cnt;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cmp(d.subarray(NODE_HDR + m * KEY_SIZE, NODE_HDR + m * KEY_SIZE + KEY_SIZE), key) < 0)
        lo = m + 1;
      else hi = m;
    }
    if (
      lo < cnt &&
      cmp(d.subarray(NODE_HDR + lo * KEY_SIZE, NODE_HDR + lo * KEY_SIZE + KEY_SIZE), key) === 0
    ) {
      const voff = NODE_HDR + (f + 1) * KEY_SIZE;
      return d.slice(voff + lo * vs, voff + lo * vs + vs);
    }
    return null;
  }

  /** The header + leaf account pubkeys a forward scan of up to `maxEntries` would traverse,
   *  for an Address Lookup Table. NOTE: this returns LEAVES only. A K-order match on a tree
   *  of height > 1 also needs each swept leaf's full root..leaf PATH (the matcher's phase-2
   *  update/delete walks `height` accounts per leaf); supply those paths too, or the match tx
   *  is under-specified and fails (ERR_BAD_PATH) -- it never settles wrong. At height 1 the
   *  leaf IS the path, so this set is sufficient. */
  async scanAccounts(r: AccountReader, maxEntries: number): Promise<PublicKey[]> {
    const h = await this.header(r);
    if (!h || h.height === 0) return [];
    const out = [this.headerPda()[0]];
    let idx = h.leftmost;
    let seen = 0;
    while (idx !== 0n && seen < maxEntries) {
      const pk = this.nodePda(idx)[0];
      out.push(pk);
      const d = await r.accountData(pk);
      if (!d) break;
      seen += rdU16(d, N_KEY_COUNT);
      idx = rdU64(d, N_NEXT_LEAF);
    }
    return out;
  }
}

// ---- staleness retry model ----

export type Attempt<T> =
  | { kind: "done"; value: T } // success
  | { kind: "stale" } // cached path went stale (ERR_BAD_PATH after a concurrent split/merge)
  | { kind: "fatal"; error: unknown }; // a real error -> stop retrying

export const done = <T>(value: T): Attempt<T> => ({ kind: "done", value });
export const stale = (): Attempt<never> => ({ kind: "stale" });
export const fatal = (error: unknown): Attempt<never> => ({ kind: "fatal", error });

/** Re-resolve + resubmit up to `attempts` times. `f` resolves the instruction from FRESH
 *  state (the planner reads live accounts each call) and submits it, returning a `stale`
 *  Attempt to retry. Splits are rare (leaf-full), but between resolving a path and the tx
 *  landing a concurrent writer may have split/merged a node (ERR_BAD_PATH); just
 *  re-resolve. Compare Header.structureEpoch to detect it cheaply.
 *  Resolves to {ok:true,value} on success, {ok:false,error} on fatal, null if exhausted. */
export async function retry<T>(
  attempts: number,
  f: () => Promise<Attempt<T>>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | null> {
  for (let i = 0; i < attempts; i++) {
    const a = await f();
    if (a.kind === "done") return { ok: true, value: a.value };
    if (a.kind === "fatal") return { ok: false, error: a.error };
  }
  return null;
}
