"use client";

// Live book hook: polls the ask/bid Torna trees off-chain via the SDK (the SAME planner an
// integrator uses) and decodes orders. This is "read the book from the on-chain tree" -- no
// indexer, no slab. Sentinel (size 0) entries are filtered out.
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { keys, type Tree, type AccountReader } from "torna-sdk";
import { askTree, bidTree, connection, reader } from "./market";

export interface Order {
  price: bigint;
  size: bigint;
  maker: string;
  keyHex: string;
}

function decode(side: typeof keys.Side.Ask | typeof keys.Side.Bid, e: { key: Uint8Array; value: Uint8Array }): Order {
  const dv = new DataView(e.value.buffer, e.value.byteOffset, e.value.byteLength);
  return {
    price: keys.priceOf(side, e.key),
    size: dv.getBigUint64(32, false),
    maker: new PublicKey(e.value.subarray(0, 32)).toBase58(),
    keyHex: Buffer.from(e.key).toString("hex"),
  };
}

async function scanSide(r: AccountReader, tree: Tree, side: typeof keys.Side.Ask | typeof keys.Side.Bid): Promise<Order[]> {
  const rows = await tree.scan(r, 64);
  return rows.map((e) => decode(side, e)).filter((o) => o.size > 0n);
}

export interface BookState {
  asks: Order[];
  bids: Order[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useBook(pollMs = 5000): BookState {
  const [asks, setAsks] = useState<Order[]>([]);
  const [bids, setBids] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = reader(connection());
      const [a, b] = await Promise.all([
        scanSide(r, askTree(), keys.Side.Ask),
        scanSide(r, bidTree(), keys.Side.Bid),
      ]);
      setAsks(a);
      setBids(b);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    // don't poll a backgrounded tab (big 429 reducer); refresh on regaining focus
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, pollMs);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, pollMs]);

  return { asks, bids, loading, error, refresh: load };
}
