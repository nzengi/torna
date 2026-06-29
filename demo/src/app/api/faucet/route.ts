// Devnet faucet: mints demo base/quote tokens (+ a little SOL for fees) to a connected wallet so a
// juror can trade with their OWN wallet. Signs ONLY with the dedicated FAUCET key (never id.json).
// Server-only (nodejs). Set FAUCET_SECRET in prod; locally reads deploy/faucet-keypair.json.
//
// Hardening (adversarial review, 2 rounds): single atomic tx; idempotent on BOTH token balances;
// a reserve floor (incl. rent) so the faucet can never be fully drained; a per-instance daily
// lamport budget; per-dest + per-IP + global cooldowns recorded before the spend and ROLLED BACK on
// no-spend branches; generic client errors. NOTE: the cooldown/daily limiters are in-memory (per
// process); on a SERVERLESS deploy move them to shared storage (Upstash/KV) and read the client IP
// from the platform's TRUSTED signal (x-forwarded-for's left hop is spoofable). The reserve floor
// reads on-chain balance so it is shared and remains the real anti-drain backstop.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, getAccount,
} from "@solana/spl-token";
import market from "@/lib/market.json";

export const runtime = "nodejs";

const BASE_AMT = 1000n;
const QUOTE_AMT = 1_000_000n;
const SOL_LAMPORTS = 20_000_000;          // 0.02 SOL, enough for many devnet tx fees
const ATA_RENT = 2_040_000;               // ~rent per token account the faucet creates
const CALL_COST = SOL_LAMPORTS + 2 * ATA_RENT + 10_000; // true per-call cost (incl. rent + fee)
const RESERVE_LAMPORTS = 200_000_000;     // never dispense below 0.2 SOL
const MAX_DAILY_LAMPORTS = 1_000_000_000; // per-instance daily dispense cap (~1 SOL/day)
const DEST_COOLDOWN_MS = 5 * 60_000;      // one top-up per wallet / 5 min
const IP_COOLDOWN_MS = 30_000;            // one request per IP / 30s
const GLOBAL_MAX_PER_MIN = 30;            // hard global rate cap
const FUNDED_BASE = 500n;                 // "already funded" thresholds (skip re-fund)
const FUNDED_QUOTE = 500_000n;

function faucetKey(): Keypair {
  const env = process.env.FAUCET_SECRET;
  const raw = env ? JSON.parse(env) : JSON.parse(readFileSync(join(process.cwd(), "deploy/faucet-keypair.json"), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// in-memory limiters (per process, see header note)
const destSeen = new Map<string, number>();
const ipSeen = new Map<string, number>();
let globalHits: { t: number }[] = [];
let dayStart = 0;
let daySpent = 0;

const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
const tooSoon = (m: Map<string, number>, k: string, ms: number, now: number) => now - (m.get(k) ?? 0) < ms;

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 1024) return NextResponse.json({ error: "bad request" }, { status: 413 });

  let dest: PublicKey;
  try {
    const { pubkey } = await req.json();
    dest = new PublicKey(pubkey);
  } catch {
    return NextResponse.json({ error: "invalid pubkey" }, { status: 400 });
  }
  const destStr = dest.toBase58();

  const now = Date.now();
  const ip = clientIp(req);
  globalHits = globalHits.filter((h) => now - h.t < 60_000);
  if (now - dayStart > 86_400_000) { dayStart = now; daySpent = 0; }
  if (globalHits.length >= GLOBAL_MAX_PER_MIN) return NextResponse.json({ error: "faucet busy, try again shortly" }, { status: 429 });
  if (tooSoon(ipSeen, ip, IP_COOLDOWN_MS, now)) return NextResponse.json({ error: "rate limited, wait a moment" }, { status: 429 });
  if (tooSoon(destSeen, destStr, DEST_COOLDOWN_MS, now)) return NextResponse.json({ error: "this wallet was funded recently" }, { status: 429 });
  if (daySpent + CALL_COST > MAX_DAILY_LAMPORTS) return NextResponse.json({ error: "faucet daily limit reached" }, { status: 503 });

  // reserve ALL limiters (incl. the daily budget) BEFORE spending so concurrent/retry spam can't
  // bypass the windows. globalHits uses an object so rollback removes THIS entry by identity (not
  // LIFO, which could pop a concurrent request's slot).
  const myHit = { t: now };
  destSeen.set(destStr, now);
  ipSeen.set(ip, now);
  globalHits.push(myHit);
  daySpent += CALL_COST;
  // undo the dest + global + daily reservations on a no-spend exit (keep the light IP cooldown)
  const rollback = () => {
    destSeen.delete(destStr);
    const i = globalHits.indexOf(myHit);
    if (i >= 0) globalHits.splice(i, 1);
    daySpent = Math.max(0, daySpent - CALL_COST); // clamp: a 24h reset between reserve+rollback can't go negative
  };

  try {
    const conn = new Connection(process.env.NEXT_PUBLIC_RPC_URL || market.rpcUrl, "confirmed");
    const faucet = faucetKey();
    const baseMint = new PublicKey(market.baseMint);
    const quoteMint = new PublicKey(market.quoteMint);
    const baseAta = getAssociatedTokenAddressSync(baseMint, dest);
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, dest);

    // idempotent: skip only if the wallet already holds BOTH tokens (so a juror who traded their
    // quote away can still re-fund). A missing ATA reads as 0.
    const amt = async (a: PublicKey) => { try { return (await getAccount(conn, a)).amount; } catch { return 0n; } };
    if ((await amt(baseAta)) >= FUNDED_BASE && (await amt(quoteAta)) >= FUNDED_QUOTE) {
      rollback();
      return NextResponse.json({ alreadyFunded: true });
    }

    // reserve floor: never drain below 0.2 SOL (true per-call cost incl. rent)
    if (await conn.getBalance(faucet.publicKey) < RESERVE_LAMPORTS + CALL_COST) {
      rollback();
      return NextResponse.json({ error: "faucet temporarily out of funds" }, { status: 503 });
    }

    // ONE atomic tx: create ATAs (idempotent) + mint both + transfer SOL, all-or-nothing
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, baseAta, dest, baseMint),
      createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, quoteAta, dest, quoteMint),
      createMintToInstruction(baseMint, baseAta, faucet.publicKey, BASE_AMT),
      createMintToInstruction(quoteMint, quoteAta, faucet.publicKey, QUOTE_AMT),
      SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: dest, lamports: SOL_LAMPORTS }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [faucet], { commitment: "confirmed" });
    return NextResponse.json({ sig, base: BASE_AMT.toString(), quote: QUOTE_AMT.toString(), sol: SOL_LAMPORTS / 1e9 });
  } catch (e) {
    rollback(); // the spend didn't land; don't burn the user's dest cooldown
    console.error("faucet error:", e);
    return NextResponse.json({ error: "faucet unavailable, try again" }, { status: 500 });
  }
}
