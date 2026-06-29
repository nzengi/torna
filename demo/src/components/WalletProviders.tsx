"use client";

// Wallet adapter context. Modern wallets (Phantom, Solflare, Backpack) register via the Wallet
// Standard and are auto-detected, so the explicit adapter list can be empty. Endpoint is the shared
// (dedicated, if configured) RPC.
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { rpcUrl } from "@/lib/market";
import "@solana/wallet-adapter-react-ui/styles.css";

export function WalletProviders({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => rpcUrl(), []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
