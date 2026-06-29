import { MARKET, explorerAddr, shorten } from "@/lib/market";

export function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold tracking-tight">
            Torna<span className="text-brand">DEX</span>
          </span>
          <span className="hidden text-xs text-faint sm:inline">parallel on-chain CLOB</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-bid">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bid opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-bid" />
            </span>
            Live on devnet
          </span>
          <a className="nums text-muted hover:text-fg" href={explorerAddr(MARKET.tornaProgramId)} target="_blank" rel="noreferrer">
            engine {shorten(MARKET.tornaProgramId)}
          </a>
          <a className="nums text-muted hover:text-fg" href={explorerAddr(MARKET.orderbookProgramId)} target="_blank" rel="noreferrer">
            book {shorten(MARKET.orderbookProgramId)}
          </a>
        </div>
      </div>
    </header>
  );
}
