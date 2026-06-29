// Devnet faucet: mints demo base/quote tokens (and a little SOL for fees) to a connected wallet so
// a juror can trade with their OWN wallet. Signs with the dedicated FAUCET key only (never id.json).
// Server-only (nodejs runtime). Configure FAUCET_SECRET in prod; locally reads deploy/faucet-keypair.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import market from "@/lib/market.json";

export const runtime = "nodejs";

const BASE_AMT = 1000n;
const QUOTE_AMT = 1_000_000n;
const SOL_LAMPORTS = 50_000_000; // 0.05 SOL for tx fees

function faucetKey(): Keypair {
  const env = process.env.FAUCET_SECRET;
  const raw = env ? JSON.parse(env) : JSON.parse(readFileSync(join(process.cwd(), "deploy/faucet-keypair.json"), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// best-effort per-pubkey cooldown (resets on server restart)
const lastHit = new Map<string, number>();
const COOLDOWN_MS = 60_000;

export async function POST(req: Request) {
  let dest: PublicKey;
  try {
    const { pubkey } = await req.json();
    dest = new PublicKey(pubkey);
  } catch {
    return NextResponse.json({ error: "invalid pubkey" }, { status: 400 });
  }

  const now = Date.now();
  const prev = lastHit.get(dest.toBase58()) ?? 0;
  if (now - prev < COOLDOWN_MS) {
    return NextResponse.json({ error: "rate limited — try again in a minute" }, { status: 429 });
  }

  try {
    const conn = new Connection(process.env.NEXT_PUBLIC_RPC_URL || market.rpcUrl, "confirmed");
    const faucet = faucetKey();
    const baseMint = new PublicKey(market.baseMint);
    const quoteMint = new PublicKey(market.quoteMint);

    // ATAs (faucet pays rent so the juror needs no SOL up front)
    const baseAta = await getOrCreateAssociatedTokenAccount(conn, faucet, baseMint, dest);
    const quoteAta = await getOrCreateAssociatedTokenAccount(conn, faucet, quoteMint, dest);

    await mintTo(conn, faucet, baseMint, baseAta.address, faucet, BASE_AMT);
    const sig = await mintTo(conn, faucet, quoteMint, quoteAta.address, faucet, QUOTE_AMT);

    // a little SOL so they can pay their own tx fees
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: dest, lamports: SOL_LAMPORTS }),
    ), [faucet], { commitment: "confirmed" });

    lastHit.set(dest.toBase58(), now);
    return NextResponse.json({ sig, base: BASE_AMT.toString(), quote: QUOTE_AMT.toString(), sol: SOL_LAMPORTS / 1e9 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
