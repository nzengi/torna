import { ImageResponse } from "next/og";

// Branded favicon: a neon "T" mark matching the nav logo.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#00ff88",
          color: "#000000",
          fontSize: 23,
          fontWeight: 700,
          borderRadius: 7,
        }}
      >
        T
      </div>
    ),
    { ...size },
  );
}
