import { MARKET } from "@/lib/market";
import { Address } from "./ui/Address";

export function Footer() {
  return (
    <footer className="mt-10 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="flex items-center gap-1.5 text-muted">engine <Address value={MARKET.tornaProgramId} /></span>
          <span className="flex items-center gap-1.5 text-muted">book <Address value={MARKET.orderbookProgramId} /></span>
          <span className="flex items-center gap-1.5 text-muted">market <Address value={MARKET.cfg} /></span>
        </div>
        <p className="max-w-md leading-relaxed">
          In-house adversarial review to convergence (engine, orderbook, SDK). External audit pending,
          do not treat as production-audited. Devnet only.
        </p>
      </div>
    </footer>
  );
}
