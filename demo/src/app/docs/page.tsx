import Link from "next/link";
import { TornaDocs, DexDocs, TORNA_TOC, DEX_TOC } from "@/components/DocsContent";

export const metadata = {
  title: "Docs · Torna and TornaDEX",
  description:
    "Documentation for Torna, the parallel ordered on-chain index primitive for Solana, and TornaDEX, the reference order book built on it.",
};

// Tabs are driven by the URL (?tab=tornadex), so the whole page stays a server component and the code
// blocks are syntax-highlighted at build time. The tab is shareable and survives reload.
export default async function DocsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab === "tornadex" ? "tornadex" : "torna";
  const toc = tab === "torna" ? TORNA_TOC : DEX_TOC;
  const tabs: [string, string, string][] = [
    ["torna", "/docs", "Torna · the primitive"],
    ["tornadex", "/docs?tab=tornadex", "TornaDEX · reference app"],
  ];
  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Documentation</p>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
        Two products, documented separately. <span className="font-medium text-fg">Torna</span> is the
        on-chain index primitive you build on; <span className="font-medium text-fg">TornaDEX</span> is the
        reference order book built on it.
      </p>
      <div className="mt-5 inline-flex rounded-xl border border-line p-1 text-sm">
        {tabs.map(([t, href, label]) => (
          <Link key={t} href={href} scroll={false}
            className={`rounded-lg px-4 py-2 font-medium transition-colors duration-100 ${tab === t ? "bg-brand text-onbrand" : "text-muted hover:text-fg"}`}>
            {label}
          </Link>
        ))}
      </div>

      <div className="mt-8 gap-12 lg:grid lg:grid-cols-[210px_1fr]">
        <aside className="hidden lg:block">
          <nav className="sticky top-24 space-y-0.5 text-sm">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">On this page</div>
            {toc.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="block rounded px-2 py-1 text-muted transition-colors duration-100 hover:bg-panel-hi hover:text-fg">{label}</a>
            ))}
          </nav>
        </aside>
        {tab === "torna" ? <TornaDocs /> : <DexDocs />}
      </div>
    </div>
  );
}
