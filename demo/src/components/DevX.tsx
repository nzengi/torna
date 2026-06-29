"use client";

// The DX moat. The integrator writes a key + value; the SDK resolves the exact account set off-chain
// (node_idx, bumps, path, spares never appear). We resolve a REAL place account set for a sample order
// against devnet to make the "what the SDK did" column concrete.
import { useEffect, useState } from "react";
import { Keypair } from "@solana/web3.js";
import { placeIx, ASK } from "@/lib/orderbook";
import { askTree, connection, marketId, orderbookProgram, reader, tornaProgram, shorten, MARKET } from "@/lib/market";

const CODE = `import { Tree, keys } from "torna-sdk";

const tree = new Tree(program, creator, askTreeId);
const key  = keys.orderKey(Side.Ask, price, slot, maker, nonce);

// the planner reads the tree off-chain and returns the exact accounts
const { ix } = await placeIx({ reader, tree, side: ASK, price, size, ... });
// node_idx / bump / path / spares: never touched by you`;

export function DevX() {
  const [accounts, setAccounts] = useState<{ role: string; addr: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const maker = Keypair.fromSecretKey(Uint8Array.from(MARKET.demos[0].secret));
        const { ix } = await placeIx({
          reader: reader(connection()), tree: askTree(), orderbook: orderbookProgram(), torna: tornaProgram(),
          marketId: marketId(), side: ASK, price: 104n, size: 1n, nonce: 99n,
          maker: maker.publicKey, makerSrc: maker.publicKey, vault: maker.publicKey,
        });
        const roles = ["maker", "book PDA", "torna", "ask header", "maker src", "vault", "token prog", "cfg"];
        setAccounts(ix.keys.map((k, i) => ({ role: roles[i] ?? `path[${i - 8}] (resolved)`, addr: k.pubkey.toBase58() })));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return (
    <section className="mx-auto max-w-6xl px-6 py-14">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">Build your own on Torna</div>
      <h2 className="display text-2xl font-semibold tracking-tight">From a key to the exact accounts</h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        This is what an integrating program does, not just TornaDEX. You call with a key; the SDK reads
        the tree and emits the exact account set. The hard parts (node indices, PDA bumps, the descent
        path, split spares) never leave the library. Below is a real place resolved live on devnet.
      </p>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel">
          <div className="border-b border-line px-4 py-2 text-xs uppercase tracking-wide text-faint">what you write</div>
          <pre className="nums overflow-x-auto px-4 py-3 text-xs leading-relaxed text-fg">{CODE}</pre>
        </div>
        <div className="rounded-lg border border-line bg-panel">
          <div className="border-b border-line px-4 py-2 text-xs uppercase tracking-wide text-faint">
            what the SDK resolved (live, devnet)
          </div>
          <div className="divide-y divide-line/60 px-4">
            {err && <div className="py-3 text-xs text-ask">{err}</div>}
            {!accounts && !err && <div className="py-3 text-xs text-faint">resolving…</div>}
            {accounts?.map((a, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                <span className={a.role.startsWith("path") ? "text-parallel" : "text-muted"}>{a.role}</span>
                <span className="nums text-fg">{shorten(a.addr)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
