"use client";

// Live book hook. Reads the book from the cached server endpoint (/api/book), which reads the on-chain
// Torna trees once per TTL and serves the snapshot to all viewers. So the browser polls our server, not
// the RPC directly: many viewers share one upstream read and the RPC is never hit constantly.
import { useCallback, useEffect, useRef, useState } from "react";

export interface Order {
  price: bigint;
  size: bigint;
  maker: string;
  keyHex: string;
}

export interface BookState {
  asks: Order[];
  bids: Order[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const parse = (rows: { price: string; size: string; maker: string; keyHex: string }[]): Order[] =>
  rows.map((o) => ({ price: BigInt(o.price), size: BigInt(o.size), maker: o.maker, keyHex: o.keyHex }));

export function useBook(pollMs = 20000): BookState {
  const [asks, setAsks] = useState<Order[]>([]);
  const [bids, setBids] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/book", { cache: "no-store" });
      const j = await res.json();
      setAsks(parse(j.asks ?? []));
      setBids(parse(j.bids ?? []));
      setError(j.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    // don't poll a backgrounded tab; refresh on regaining focus
    const id = setInterval(() => { if (!document.hidden) load(); }, pollMs);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load, pollMs]);

  return { asks, bids, loading, error, refresh: load };
}
