import { Terminal } from "@/components/Terminal";
import { DevX } from "@/components/DevX";

export default function TradePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">The reference app, built on Torna</p>
        <h1 className="display mt-2 text-3xl font-semibold tracking-tight">TornaDEX</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          TornaDEX is a central limit order book built on the Torna index, the live proof that the
          primitive works end to end. Trade as one of four pre-funded demo identities, or connect your
          own wallet and grab demo tokens from the faucet. Place, take, and cancel are real devnet
          transactions; the book is read straight from the on-chain B+ tree, with no indexer.
        </p>
      </div>

      <Terminal />

      <div className="mt-12">
        <DevX />
      </div>
    </div>
  );
}
