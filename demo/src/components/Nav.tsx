"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { GithubIcon } from "./ui/GithubIcon";

// wallet-adapter renders the button differently once it can read wallet state on the client, which
// causes an SSR hydration mismatch. Render it client-only.
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/trade", label: "Trade" },
  { href: "/build", label: "Build" },
  { href: "/docs", label: "Docs" },
  { href: "/research", label: "Research" },
  { href: "/explorer", label: "Explorer" },
];

export function Nav() {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Torna home">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-[13px] font-bold text-onbrand">T</span>
          <span className="text-lg font-semibold tracking-tight">Torna</span>
          <span className="hidden text-xs text-faint lg:inline">· on-chain index</span>
        </Link>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors duration-100 ${
                active(l.href) ? "bg-panel-hi font-medium text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <a href="https://github.com/nzengi/torna" target="_blank" rel="noreferrer" aria-label="Torna on GitHub"
            className="hidden rounded-md p-1.5 text-muted transition-colors duration-100 hover:bg-panel-hi hover:text-fg sm:flex">
            <GithubIcon className="h-5 w-5" />
          </a>
          <span className="hidden items-center gap-1.5 rounded-full border border-serial/40 bg-serial/10 px-2.5 py-0.5 text-xs text-serial md:flex">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-serial opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-serial" />
            </span>
            devnet
          </span>
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}
