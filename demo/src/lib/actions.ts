"use client";

// Browser trade actions over an Actor abstraction: the actor is either a connected wallet
// (adapter sendTransaction) or a pre-funded demo identity (local Keypair). Each builds an
// instruction via the orderbook client, signs, sends + confirms, and returns the tx signature.
import "./polyfill";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { keys } from "torna-sdk";
import { ASK, cancelIx, matchIx, placeIx, placeColdIx, type Side } from "./orderbook";
import { MARKET, askTree, bidTree, connection, marketId, orderbookProgram, reader, tornaProgram } from "./market";

const N_KEY_COUNT = 2;
const rdU16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);

export interface Actor {
  publicKey: PublicKey;
  send: (tx: Transaction) => Promise<string>;
}

/** A pre-funded demo identity that signs locally. */
export function keypairActor(kp: Keypair): Actor {
  return {
    publicKey: kp.publicKey,
    send: (tx) => sendAndConfirmTransaction(connection(), tx, [kp], { commitment: "confirmed" }),
  };
}

/** A connected wallet (wallet-adapter sendTransaction + confirm). */
export function walletActor(
  publicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
): Actor {
  return {
    publicKey,
    send: async (tx) => {
      const conn = connection();
      // blockhash-based confirmation (not the deprecated sig-only overload): bounds confirmation by
      // block height so it can't hang indefinitely or false-fail a landed tx.
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, conn);
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return sig;
    },
  };
}

const ata = (mint: string, owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);

export async function place(actor: Actor, side: Side, price: bigint, size: bigint): Promise<string> {
  const tree = side === ASK ? askTree() : bidTree();
  const makerSrc = side === ASK ? ata(MARKET.baseMint, actor.publicKey) : ata(MARKET.quoteMint, actor.publicKey);
  const vault = new PublicKey(side === ASK ? MARKET.baseVault : MARKET.quoteVault);
  const r = reader();
  const nonce = BigInt(Date.now());
  const args = { reader: r, tree, orderbook: orderbookProgram(), torna: tornaProgram(), marketId: marketId(), side, price, size, nonce, maker: actor.publicKey, makerSrc, vault };

  // Route to the cold split path when the target leaf is full (or the tree is empty), so a place
  // never fails with ERR_NEED_SPLIT_SLOT (0x66). The split grows the tree, so subsequent places at
  // that depth go hot again; the demo self-heals.
  const h = await tree.header(r);
  if (!h) throw new Error("market tree not initialized");
  let cold = h.height === 0;
  if (!cold) {
    const key = keys.orderKey(side === ASK ? keys.Side.Ask : keys.Side.Bid, price, 0n, actor.publicKey, nonce);
    const path = await tree.path(r, key);
    if (path && path.length) {
      const d = await r.accountData(tree.nodePda(path[path.length - 1])[0]);
      if (d && rdU16(d, N_KEY_COUNT) >= h.fanout) cold = true;
    }
  }

  if (cold) {
    const rentNode = BigInt(await connection().getMinimumBalanceForRentExemption(h.nodeSize));
    const built = await placeColdIx({ ...args, rentNode });
    if (!built) throw new Error("could not resolve the cold place plan; please retry");
    return actor.send(new Transaction().add(built.ix));
  }
  const { ix } = await placeIx(args);
  return actor.send(new Transaction().add(ix));
}

export async function cancel(actor: Actor, side: Side, keyHex: string): Promise<string> {
  const tree = side === ASK ? askTree() : bidTree();
  const key = Uint8Array.from(Buffer.from(keyHex, "hex"));
  const vault = new PublicKey(side === ASK ? MARKET.baseVault : MARKET.quoteVault);
  const makerDst = side === ASK ? ata(MARKET.baseMint, actor.publicKey) : ata(MARKET.quoteMint, actor.publicKey);
  const ix = await cancelIx({
    reader: reader(), tree, orderbook: orderbookProgram(), torna: tornaProgram(), marketId: marketId(),
    side, key, maker: actor.publicKey, vault, makerDst,
  });
  return actor.send(new Transaction().add(ix));
}

export async function take(actor: Actor, bookSide: Side, limit: bigint, size: bigint): Promise<{ sig: string; fills: number } | null> {
  const tree = bookSide === ASK ? askTree() : bidTree();
  const vault = new PublicKey(bookSide === ASK ? MARKET.baseVault : MARKET.quoteVault);
  const recvMint = bookSide === ASK ? MARKET.baseMint : MARKET.quoteMint;
  const payMint = bookSide === ASK ? MARKET.quoteMint : MARKET.baseMint;
  const built = await matchIx({
    reader: reader(), tree, orderbook: orderbookProgram(), torna: tornaProgram(), marketId: marketId(),
    bookSide, limit, size, maxFills: 8, taker: actor.publicKey, vault,
    takerRecv: ata(recvMint, actor.publicKey), takerPay: ata(payMint, actor.publicKey), payMint: new PublicKey(payMint),
  });
  if (!built) return null;
  const sig = await actor.send(new Transaction().add(built.ix));
  return { sig, fills: built.fills.length };
}

/** Request demo tokens from the faucet for a connected wallet. */
export async function requestFaucet(pubkey: PublicKey): Promise<{ sig?: string; alreadyFunded?: boolean }> {
  const res = await fetch("/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubkey.toBase58() }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? "faucet failed");
  return j;
}
