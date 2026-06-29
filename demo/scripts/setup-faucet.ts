// One-time: create a dedicated FAUCET keypair, fund it with SOL, and move the base/quote mint
// authority from the deployer (id.json) to it. The faucet API route then mints demo tokens to a
// connected wallet using ONLY this key — id.json (upgrade authority + main funds) never touches the
// app. Run: npx tsx scripts/setup-faucet.ts
import "../src/lib/polyfill";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { setAuthority, AuthorityType } from "@solana/spl-token";

const M = JSON.parse(readFileSync(join(import.meta.dirname, "../src/lib/market.json"), "utf8"));
const conn = new Connection(process.env.RPC ?? M.rpcUrl, "confirmed");
const id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/id.json"), "utf8"))));
const faucetPath = join(import.meta.dirname, "../deploy/faucet-keypair.json");

async function main() {
  const faucet = existsSync(faucetPath)
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(faucetPath, "utf8"))))
    : Keypair.generate();
  if (!existsSync(faucetPath)) writeFileSync(faucetPath, JSON.stringify(Array.from(faucet.secretKey)));
  console.log("faucet:", faucet.publicKey.toBase58());

  // fund the faucet with SOL (for distributing SOL + ATA rent + mint fees)
  const bal = await conn.getBalance(faucet.publicKey);
  if (bal < 1_500_000_000) {
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: id.publicKey, toPubkey: faucet.publicKey, lamports: 2_000_000_000 - bal }),
    ), [id], { commitment: "confirmed" });
    console.log("funded faucet to ~2 SOL");
  } else {
    console.log("faucet already funded:", bal / 1e9, "SOL");
  }

  // move mint authority of base + quote from id.json to the faucet
  for (const mint of [M.baseMint, M.quoteMint] as string[]) {
    const info = await conn.getAccountInfo(new PublicKey(mint));
    const currentAuth = info ? new PublicKey(info.data.slice(4, 36)) : null; // mint layout: authority option(4) then pubkey
    if (currentAuth && currentAuth.equals(faucet.publicKey)) { console.log(mint.slice(0, 6), "authority already = faucet"); continue; }
    await setAuthority(conn, id, new PublicKey(mint), id, AuthorityType.MintTokens, faucet.publicKey);
    console.log(mint.slice(0, 6), "mint authority -> faucet");
  }

  console.log("\nDONE. deploy/faucet-keypair.json written. For hosting, set FAUCET_SECRET to its JSON array.");
}
main().catch((e) => { console.error(e); process.exit(1); });
