// Deployment-specific config for the demo. Placeholders until the devnet deploy + market
// init (demo-plan.md P1) fills these in. The CLOB reads the book via torna-sdk Tree handles
// (ask/bid) and drives place/cancel/match through the orderbook program.
//
// After P1, a deploy script writes the real values here (or to a generated config.devnet.ts
// that overrides these). Everything except the program IDs / creator / mints is derivable.

const SYSTEM = "11111111111111111111111111111111"; // PublicKey.default placeholder

export interface DemoConfig {
  cluster: "devnet" | "localnet";
  rpcUrl: string;
  /** Torna engine program (the audited sorted-index primitive). */
  tornaProgramId: string;
  /** The reference orderbook (CLOB) program that escrows + matches. */
  orderbookProgramId: string;
  /** u64 market id (decimal string). */
  marketId: string;
  /** The pubkey that created the ask/bid trees (PDA seed namespace). */
  creator: string;
  /** tree_id of the ask book and the bid book (distinct). */
  askTreeId: number;
  bidTreeId: number;
  /** SPL mints traded in this market. */
  baseMint: string;
  quoteMint: string;
}

export const config: DemoConfig = {
  cluster: "devnet",
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com",
  tornaProgramId: process.env.NEXT_PUBLIC_TORNA_PROGRAM ?? SYSTEM,
  orderbookProgramId: process.env.NEXT_PUBLIC_ORDERBOOK_PROGRAM ?? SYSTEM,
  marketId: process.env.NEXT_PUBLIC_MARKET_ID ?? "1",
  creator: process.env.NEXT_PUBLIC_CREATOR ?? SYSTEM,
  askTreeId: Number(process.env.NEXT_PUBLIC_ASK_TREE_ID ?? "1"),
  bidTreeId: Number(process.env.NEXT_PUBLIC_BID_TREE_ID ?? "2"),
  baseMint: process.env.NEXT_PUBLIC_BASE_MINT ?? SYSTEM,
  quoteMint: process.env.NEXT_PUBLIC_QUOTE_MINT ?? SYSTEM,
};

/** True once the placeholders have been replaced with a real devnet deployment. */
export const isConfigured = (): boolean =>
  config.tornaProgramId !== SYSTEM && config.orderbookProgramId !== SYSTEM;
