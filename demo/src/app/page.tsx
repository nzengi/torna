import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { Terminal } from "@/components/Terminal";
import { MarketInfo } from "@/components/MarketInfo";
import { Parallelism } from "@/components/Parallelism";
import { DevX } from "@/components/DevX";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Header />
      <Hero />

      {/* Act 1 -- the live CLOB, read straight from the on-chain tree via the SDK */}
      <section className="mx-auto max-w-6xl px-6 pb-4">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Live book</h2>
          <span className="text-xs text-faint">read from the on-chain B+ tree · no indexer</span>
        </div>
        <Terminal />
        <div className="mt-4">
          <MarketInfo />
        </div>
      </section>

      {/* Act 2 -- parallel book maintenance (the moat) */}
      <Parallelism />

      {/* Act 3 -- the SDK / DX moat */}
      <DevX />

      <Footer />
    </>
  );
}
