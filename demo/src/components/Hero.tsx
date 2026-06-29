export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-16 pb-10">
      <p className="mb-3 text-xs uppercase tracking-[0.2em] text-brand">Torna — sorted on-chain state, without the slab</p>
      <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
        A parallel, ordered, on-chain order book on Solana.
      </h1>
      <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted">
        Every order is one entry in a B+ tree whose nodes each live in their own account, so makers
        quoting at different prices write disjoint accounts and the Sealevel scheduler runs them in
        the same slot. The book is the on-chain tree; no slab allocator, no off-chain indexer.
      </p>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-faint">
        Honest scope: Torna parallelizes book <span className="text-fg">maintenance</span> (maker
        place/cancel across prices), not matching — top-of-book is price-time serial and nothing can
        change that. In a maker-heavy book, maintenance traffic dominates.
      </p>
    </section>
  );
}
