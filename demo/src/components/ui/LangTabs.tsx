"use client";

// A global TypeScript/Rust toggle for code samples. Both languages are rendered server-side (shiki at
// build time) and passed to DualCode as props; the client just shows the one the toggle selects, so
// switching is instant with no navigation and no client-side highlighter.
import { createContext, useContext, useState, type ReactNode } from "react";

type Lang = "ts" | "rust";
const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: "ts", setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>("ts");
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export function LangToggle() {
  const { lang, setLang } = useContext(LangCtx);
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5 text-xs">
      {(["ts", "rust"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          className={`rounded-md px-2.5 py-1 font-medium transition-colors duration-100 ${lang === l ? "bg-brand text-onbrand" : "text-muted hover:text-fg"}`}
        >
          {l === "ts" ? "TypeScript" : "Rust"}
        </button>
      ))}
    </div>
  );
}

export function DualCode({ ts, rust }: { ts: ReactNode; rust: ReactNode }) {
  const { lang } = useContext(LangCtx);
  return <>{lang === "ts" ? ts : rust}</>;
}
