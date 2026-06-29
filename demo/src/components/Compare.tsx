import { Check, X } from "lucide-react";

const ROWS: { dim: string; slab: string; torna: string }[] = [
  { dim: "On-chain state", slab: "One giant slab account", torna: "One small account per node" },
  { dim: "Concurrent writes", slab: "Serialized, every write locks the slab", torna: "Parallel, disjoint keys, disjoint accounts" },
  { dim: "Reading the book", slab: "Off-chain indexer you run + maintain", torna: "Walk the tree off-chain via the SDK" },
  { dim: "Ordering", slab: "Manual / re-sort", torna: "Always sorted (B+ tree invariant)" },
  { dim: "Account budget", slab: "Whole slab loaded per tx", torna: "~3 node accounts per op (height ~3)" },
  { dim: "What you write", slab: "Allocator + indexer + matching", torna: "index<K,V>, accounts resolved for you" },
];

export function Compare() {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="grid grid-cols-[1.1fr_1.4fr_1.4fr] bg-panel-hi text-xs font-semibold uppercase tracking-wide text-muted">
        <div className="px-4 py-3" />
        <div className="border-l border-line px-4 py-3">Hand-rolled slab + indexer</div>
        <div className="border-l border-line px-4 py-3 text-brand">Torna</div>
      </div>
      {ROWS.map((r, i) => (
        <div key={r.dim} className={`grid grid-cols-[1.1fr_1.4fr_1.4fr] text-sm ${i % 2 ? "bg-bg-soft" : "bg-panel"}`}>
          <div className="px-4 py-3 font-medium text-fg">{r.dim}</div>
          <div className="flex items-start gap-2 border-l border-line px-4 py-3 text-muted">
            <X className="mt-0.5 h-4 w-4 shrink-0 text-ask" aria-hidden />
            <span>{r.slab}</span>
          </div>
          <div className="flex items-start gap-2 border-l border-line px-4 py-3 text-fg">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-bid" aria-hidden />
            <span>{r.torna}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
