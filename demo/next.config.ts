import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  // @torna/sdk is a local file: dependency symlinked to ../ts-sdk (outside this app dir).
  // Point Turbopack's workspace root at the monorepo (torna/) so it follows the symlink
  // and resolves the linked package.
  turbopack: {
    root: join(__dirname, ".."),
  },
};

export default nextConfig;
