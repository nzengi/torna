"use client";

// Browser trade actions: build an instruction via the orderbook client, sign with a demo
// identity (devnet-only keypair), send + confirm. The demo identity is its own fee payer
// (funded at bring-up) and the maker/taker. Returns the tx signature for an explorer link.
import "./polyfill";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ASK, cancelIx, matchIx, placeIx, type Side } from "./orderbook";
import {
  MARKET, askTree, bidTree, connection, marketId, orderbookProgram, reader, tornaProgram,
} from "./market";

const ata = (mint: string, owner: PublicKey) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);

export async function place(maker: Keypair, side: Side, price: bigint, size: bigint): Promise<string> {
  const conn = connection();
  const tree = side === ASK ? askTree() : bidTree();
  const makerSrc = side === ASK ? ata(MARKET.baseMint, maker.publicKey) : ata(MARKET.quoteMint, maker.publicKey);
  const vault = new PublicKey(side === ASK ? MARKET.baseVault : MARKET.quoteVault);
  const { ix } = await placeIx({
    reader: reader(conn), tree, orderbook: orderbookProgram(), torna: tornaProgram(), marketId: marketId(),
    side, price, size, nonce: BigInt(Date.now()), maker: maker.publicKey, makerSrc, vault,
  });
  return sendAndConfirmTransaction(conn, new Transaction().add(ix), [maker], { commitment: "confirmed" });
}

export async function cancel(maker: Keypair, side: Side, keyHex: string): Promise<string> {
  const conn = connection();
  const tree = side === ASK ? askTree() : bidTree();
  const key = Uint8Array.from(Buffer.from(keyHex, "hex"));
  const vault = new PublicKey(side === ASK ? MARKET.baseVault : MARKET.quoteVault);
  const makerDst = side === ASK ? ata(MARKET.baseMint, maker.publicKey) : ata(MARKET.quoteMint, maker.publicKey);
  const ix = await cancelIx({
    reader: reader(conn), tree, orderbook: orderbookProgram(), torna: tornaProgram(), marketId: marketId(),
    side, key, maker: maker.publicKey, vault, makerDst,
  });
  return sendAndConfirmTransaction(conn, new Transaction().add(ix), [maker], { commitment: "confirmed" });
}

/** Take liquidity: a buy taker hits the ASK book (bookSide=ASK), a sell taker hits the BID book. */
export async function take(
  taker: Keypair, bookSide: Side, limit: bigint, size: bigint,
): Promise<{ sig: string; fills: number } | null> {
  const conn = connection();
  const tree = bookSide === ASK ? askTree() : bidTree();
  const vault = new PublicKey(bookSide === ASK ? MARKET.baseVault : MARKET.quoteVault);
  const recvMint = bookSide === ASK ? MARKET.baseMint : MARKET.quoteMint;
  const payMint = bookSide === ASK ? MARKET.quoteMint : MARKET.baseMint;
  const built = await matchIx({
    reader: reader(conn), tree, orderbook: orderbookProgram(), torna: tornaProgram(), marketId: marketId(),
    bookSide, limit, size, maxFills: 8, taker: taker.publicKey, vault,
    takerRecv: ata(recvMint, taker.publicKey), takerPay: ata(payMint, taker.publicKey), payMint: new PublicKey(payMint),
  });
  if (!built) return null;
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(built.ix), [taker], { commitment: "confirmed" });
  return { sig, fills: built.fills.length };
}
