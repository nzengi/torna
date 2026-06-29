"use client";

// Browser trade actions over an Actor abstraction: the actor is either a connected wallet
// (adapter sendTransaction) or a pre-funded demo identity (local Keypair). Each builds an
// instruction via the orderbook client, signs, sends + confirms, and returns the tx signature.
import "./polyfill";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ASK, cancelIx, matchIx, placeIx, type Side } from "./orderbook";
import { MARKET, askTree, bidTree, connection, marketId, orderbookProgram, reader, tornaProgram } from "./market";

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
      const sig = await sendTransaction(tx, conn);
      await conn.confirmTransaction(sig, "confirmed");
      return sig;
    },
  };
}

const ata = (mint: string, owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);

export async function place(actor: Actor, side: Side, price: bigint, size: bigint): Promise<string> {
  const tree = side === ASK ? askTree() : bidTree();
  const makerSrc = side === ASK ? ata(MARKET.baseMint, actor.publicKey) : ata(MARKET.quoteMint, actor.publicKey);
  const vault = new PublicKey(side === ASK ? MARKET.baseVault : MARKET.quoteVault);
  const { ix } = await placeIx({
    reader: reader(), tree, orderbook: orderbookProgram(), torna: tornaProgram(), marketId: marketId(),
    side, price, size, nonce: BigInt(Date.now()), maker: actor.publicKey, makerSrc, vault,
  });
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
export async function requestFaucet(pubkey: PublicKey): Promise<{ sig: string }> {
  const res = await fetch("/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubkey.toBase58() }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? "faucet failed");
  return j;
}
