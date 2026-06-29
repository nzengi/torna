"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { explorerAddr, shorten } from "@/lib/market";

// A devnet address: monospace + truncated for scanning, click-to-copy with transient feedback,
// and a separate explorer link (so clicking the text to copy never navigates away). chars=4.
export function Address({ value, chars = 4 }: { value: string; chars?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; ignore */
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={copy}
        title={value}
        aria-label={`Copy address ${value}`}
        className="nums inline-flex items-center gap-1 text-fg transition-colors duration-100 hover:text-brand"
      >
        {chars >= 99 ? value : shorten(value)}
        {copied ? <Check className="h-3 w-3 text-bid" aria-hidden /> : <Copy className="h-3 w-3 text-faint" aria-hidden />}
      </button>
      <a
        href={explorerAddr(value)}
        target="_blank"
        rel="noreferrer"
        aria-label="View on Solana Explorer (devnet)"
        className="text-faint transition-colors duration-100 hover:text-brand"
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </span>
  );
}
