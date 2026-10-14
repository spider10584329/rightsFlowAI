"use client";

/**
 * Last-resort boundary when the root layout itself fails. It replaces the
 * root layout, so it cannot rely on providers or global CSS variables.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f6f7fb", color: "#0f1222" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          <div style={{ maxWidth: 440, textAlign: "center" }}>
            <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>RightsFlow hit an unexpected error</h1>
            <p style={{ color: "#474f66", fontSize: 14, lineHeight: 1.6, margin: "0 0 16px" }}>
              Please try again. If the problem continues, contact support
              {error.digest ? (
                <>
                  {" "}
                  with reference <code>{error.digest}</code>
                </>
              ) : null}
              .
            </p>
            <button
              type="button"
              onClick={() => retry()}
              style={{ background: "#4f46e5", color: "#fff", border: 0, borderRadius: 8, padding: "10px 16px", fontSize: 14, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
