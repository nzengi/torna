// Browser-side wiring to Torna: a devnet Connection, an AccountReader the torna-sdk planner
// reads through, and the ask/bid Tree handles for this market. The CLOB renders the book from
// these (scan/best/get); place/cancel/match instructions go to the orderbook program.
import "./polyfill"; // MUST be first: installs Buffer before web3.js is evaluated
import { Connection, PublicKey } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import { config } from "./config";

export function connection(): Connection {
  return new Connection(config.rpcUrl, "confirmed");
}

/** The SDK reads raw account bytes through this; here it is a devnet RPC. */
export function reader(conn: Connection = connection()): AccountReader {
  return {
    async accountData(key: PublicKey): Promise<Uint8Array | null> {
      const info = await conn.getAccountInfo(key, "confirmed");
      return info ? Uint8Array.from(info.data) : null;
    },
  };
}

export const tornaProgram = (): PublicKey => new PublicKey(config.tornaProgramId);
export const orderbookProgram = (): PublicKey => new PublicKey(config.orderbookProgramId);
export const creator = (): PublicKey => new PublicKey(config.creator);

/** Ask book (ascending price) and bid book (descending price) as torna-sdk Tree handles. */
export const askTree = (): Tree => new Tree(tornaProgram(), creator(), config.askTreeId);
export const bidTree = (): Tree => new Tree(tornaProgram(), creator(), config.bidTreeId);
