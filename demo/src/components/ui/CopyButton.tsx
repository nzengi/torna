"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked; no-op */ }
      }}
      aria-label={copied ? "Copied" : "Copy code"}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-faint transition-colors duration-100 hover:bg-panel-hi hover:text-fg"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-bid" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
