import { Terminal } from "@/components/Terminal";
import { MarketInfo } from "@/components/MarketInfo";
import { DevX } from "@/components/DevX";

export default function TradePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <h1 className="display text-3xl font-semibold tracking-tight">Live order book</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Read straight from the on-chain B+ tree via the SDK, no indexer. Place, take, and cancel as
          one of four pre-funded devnet identities; every action is a real transaction with an explorer
          link. The book refreshes automatically.
        </p>
      </div>

      <Terminal />

      <div className="mt-6">
        <MarketInfo />
      </div>

      <div className="mt-10">
        <DevX />
      </div>
    </div>
  );
}
