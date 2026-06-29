"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/trade", label: "Trade" },
  { href: "/docs", label: "Docs" },
  { href: "/explorer", label: "Explorer" },
];

export function Nav() {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Torna<span className="text-brand">DEX</span>
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors duration-100 ${
                active(l.href) ? "bg-panel-hi font-medium text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
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
