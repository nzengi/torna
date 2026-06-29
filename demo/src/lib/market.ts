// The deployed devnet market (written by scripts/bringup.ts). Single source the UI reads:
// program IDs, the market PDAs, mints/vaults, and the pre-funded demo identities used to sign
// place/cancel/match in the browser (devnet-only; never real funds).
import "./polyfill";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import marketJson from "./market.json";

export interface DemoIdentity {
  pubkey: string;
  secret: number[];
}
export interface Market {
  cluster: string;
  rpcUrl: string;
  tornaProgramId: string;
  orderbookProgramId: string;
  marketId: string;
  bookBump: number;
  creator: string;
  askTreeId: number;
  bidTreeId: number;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  book: string;
  cfg: string;
  demos: DemoIdentity[];
}

export const MARKET = marketJson as Market;

export const connection = (): Connection => new Connection(MARKET.rpcUrl, "confirmed");

export const reader = (conn: Connection = connection()): AccountReader => ({
  async accountData(key: PublicKey): Promise<Uint8Array | null> {
    const info = await conn.getAccountInfo(key, "confirmed");
    return info ? Uint8Array.from(info.data) : null;
  },
});

export const tornaProgram = (): PublicKey => new PublicKey(MARKET.tornaProgramId);
export const orderbookProgram = (): PublicKey => new PublicKey(MARKET.orderbookProgramId);
export const marketId = (): bigint => BigInt(MARKET.marketId);

export const askTree = (): Tree => new Tree(tornaProgram(), new PublicKey(MARKET.creator), MARKET.askTreeId);
export const bidTree = (): Tree => new Tree(tornaProgram(), new PublicKey(MARKET.creator), MARKET.bidTreeId);

export const demoKeypair = (i: number): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(MARKET.demos[i].secret));

const short = (s: string): string => `${s.slice(0, 4)}…${s.slice(-4)}`;
export const shorten = short;

const base = "https://explorer.solana.com";
export const explorerAddr = (addr: string): string => `${base}/address/${addr}?cluster=devnet`;
export const explorerTx = (sig: string): string => `${base}/tx/${sig}?cluster=devnet`;
