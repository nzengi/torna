import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletProviders } from "@/components/WalletProviders";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "TornaDEX — a parallel on-chain order book on Solana",
  description:
    "TornaDEX is a central limit order book built on Torna: a parallel, ordered, on-chain B+ tree index where every node is its own account, so makers quoting at different prices write in parallel.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
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
