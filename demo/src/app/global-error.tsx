"use client";

// Explicit global error boundary. Also sidesteps a Next 16 / Turbopack dev-manifest bug where the
// builtin global-error module isn't found in the React Client Manifest.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f7f3ea", color: "#1c1814", margin: 0 }}>
        <div style={{ maxWidth: 480, margin: "20vh auto", padding: 24, textAlign: "center" }}>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h2>
          <p style={{ color: "#5c5346", fontSize: 14, marginTop: 8 }}>{error.message}</p>
          <button
            onClick={reset}
            style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8, background: "#6d28d9", color: "#fff", border: 0, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
