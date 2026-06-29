import { Explorer } from "@/components/Explorer";
import { MarketInfo } from "@/components/MarketInfo";

export default function ExplorerPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">On-chain inspector</p>
      <h1 className="display mt-2 text-4xl font-semibold tracking-tight">The book, as a live tree</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
        Read directly from devnet: the ask and bid B+ trees, their headers, and the leaf chain that
        holds the resting orders. Each leaf is its own account — click to open it on the Solana
        Explorer. This is the actual on-chain state, not a cache.
      </p>

      <div className="mt-8">
        <Explorer />
      </div>

      <div className="mt-10">
        <h2 className="display mb-3 text-xl font-semibold tracking-tight">Market accounts</h2>
        <MarketInfo />
      </div>
    </div>
  );
}
