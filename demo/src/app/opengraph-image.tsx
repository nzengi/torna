import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Torna, a parallel ordered on-chain index for Solana";

export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#06070b",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 64, height: 64, borderRadius: 14, background: "#00ff88", color: "#000000", fontSize: 40, fontWeight: 800 }}>T</div>
          <div style={{ fontSize: 40, fontWeight: 700, color: "#ffffff" }}>Torna</div>
          <div style={{ fontSize: 26, color: "#9aa0b4" }}>· on-chain index</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 74, fontWeight: 700, color: "#f5f6fa", lineHeight: 1.05 }}>A parallel, ordered index for Solana.</div>
          <div style={{ display: "flex", fontSize: 30, color: "#c8cad6" }}>Sorted on-chain state, without the slab. Live on devnet, SDK on npm.</div>
        </div>
        <div style={{ display: "flex", height: 10, borderRadius: 6, background: "linear-gradient(90deg, #00ff88, #0088ff, #ff2d8e)" }} />
      </div>
    ),
    { ...size },
  );
}
