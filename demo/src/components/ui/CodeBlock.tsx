import { codeToHtml } from "shiki";
import { CopyButton } from "./CopyButton";

// Syntax-highlighted code, rendered at BUILD time with shiki (One Dark Pro). Server-only, so no
// highlighter ships to the client. Use a real lang ("typescript", "rust", "bash") or "text".
export async function CodeBlock({ lang = "text", children }: { lang?: string; children: string }) {
  const html = await codeToHtml(children.trim(), { lang, theme: "one-dark-pro" });
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">{lang === "text" ? "code" : lang}</span>
        <CopyButton text={children.trim()} />
      </div>
      <div
        style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
        className="overflow-x-auto bg-[#07070b] text-[12.5px] leading-[1.65] [&_pre]:!bg-transparent [&_pre]:px-4 [&_pre]:py-4 [&_code]:!bg-transparent"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
