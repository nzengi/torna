import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletProviders } from "@/components/WalletProviders";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://torna.vercel.app"),
  title: "Torna, a parallel ordered on-chain index for Solana",
  description:
    "Torna is the first parallel, ordered, on-chain index primitive for Solana: a sorted B+ tree where every node is its own account, so writes at different keys run in the same slot. Build order books, queues, leaderboards, and governance on it. TornaDEX is the live reference order book.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=clash-grotesk@300,400,500,600,700&display=swap"
        />
      </head>
      <body className="flex min-h-full flex-col">
        <WalletProviders>
          <Nav />
          <main className="flex-1">{children}</main>
          <Footer />
        </WalletProviders>
      </body>
    </html>
  );
}
