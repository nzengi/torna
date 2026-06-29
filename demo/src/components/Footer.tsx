import { MARKET, explorerAddr, shorten } from "@/lib/market";

export function Footer() {
  return (
    <footer className="mt-10 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-8 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <a className="nums hover:text-fg" href={explorerAddr(MARKET.tornaProgramId)} target="_blank" rel="noreferrer">
            engine {shorten(MARKET.tornaProgramId)} ↗
          </a>
          <a className="nums hover:text-fg" href={explorerAddr(MARKET.orderbookProgramId)} target="_blank" rel="noreferrer">
            book {shorten(MARKET.orderbookProgramId)} ↗
          </a>
          <a className="nums hover:text-fg" href={explorerAddr(MARKET.cfg)} target="_blank" rel="noreferrer">
            market {shorten(MARKET.cfg)} ↗
          </a>
        </div>
        <p className="max-w-md leading-relaxed">
          In-house adversarial review to convergence (engine, orderbook, SDK). External audit pending —
          do not treat as production-audited. Devnet only.
        </p>
      </div>
    </footer>
  );
}
