import { Explorer } from "@/components/Explorer";

export default function ExplorerPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Block explorer</p>
      <h1 className="display mt-2 text-4xl font-semibold tracking-tight">Torna Explorer</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
        A Torna-aware view of the live TornaDEX market on devnet: the ask and bid B+ trees, every leaf
        account and the orders it holds, the bound market accounts, and the escrow vault balances.
        Decode any account or transaction into its on-chain fields. This is the actual state, read each
        refresh, not a cache. Every address opens on the Solana Explorer.
      </p>
      <div className="mt-8">
        <Explorer />
      </div>
    </div>
  );
}
