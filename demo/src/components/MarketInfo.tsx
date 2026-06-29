import { MARKET, askTree, bidTree, explorerAddr, shorten } from "@/lib/market";

const askHeader = () => askTree().headerPda()[0].toBase58();
const bidHeader = () => bidTree().headerPda()[0].toBase58();

function Addr({ label, addr }: { label: string; addr: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <a className="nums text-fg hover:text-brand" href={explorerAddr(addr)} target="_blank" rel="noreferrer">
        {shorten(addr)} ↗
      </a>
    </div>
  );
}

export function MarketInfo() {
  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="border-b border-line px-4 py-2 text-sm font-medium">Market accounts</div>
      <div className="divide-y divide-line/60 px-4">
        <Addr label="market config (cfg)" addr={MARKET.cfg} />
        <Addr label="book authority (PDA)" addr={MARKET.book} />
        <Addr label="ask tree header" addr={askHeader()} />
        <Addr label="bid tree header" addr={bidHeader()} />
        <Addr label="base mint" addr={MARKET.baseMint} />
        <Addr label="quote mint" addr={MARKET.quoteMint} />
        <Addr label="base vault (escrow)" addr={MARKET.baseVault} />
        <Addr label="quote vault (escrow)" addr={MARKET.quoteVault} />
      </div>
      <div className="border-t border-line px-4 py-2 text-xs text-faint">
        Two trees (ask + bid), two vaults, one config — all owned by the book PDA. Bids and asks
        never share a writable account.
      </div>
    </div>
  );
}
