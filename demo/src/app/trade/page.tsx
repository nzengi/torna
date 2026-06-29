import { Terminal } from "@/components/Terminal";
import { DevX } from "@/components/DevX";

export default function TradePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <h1 className="display text-3xl font-semibold tracking-tight">Trade</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          A live central limit order book on devnet. Trade as one of four pre-funded demo identities,
          or connect your own wallet and grab demo tokens from the faucet. Place, take, and cancel are
          real transactions; the book is read straight from the on-chain B+ tree, with no indexer.
        </p>
      </div>

      <Terminal />

      <div className="mt-12">
        <DevX />
      </div>
    </div>
  );
}
