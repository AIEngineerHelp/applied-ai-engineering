"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", maxWidth: 480, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
        <p style={{ color: "#586172" }}>The app hit an unexpected error. Please reload the page.</p>
        <button onClick={reset} style={{ marginTop: 16, padding: "8px 14px", borderRadius: 8, border: "1px solid #d5dbe3", background: "#1f4e8c", color: "#fff" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
