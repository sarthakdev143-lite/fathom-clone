export default function Home() {
  return (
    <main>
      <h1>Fathom clone</h1>
      <p className="lede">
        Record a meeting, get a transcript and a summary. Shell is live; capture,
        transcription and summarization land next.
      </p>
      <div className="card">
        <strong>Build status</strong>
        <p style={{ margin: "0.5rem 0 0", color: "var(--muted)" }}>
          Empty shell deployed.
        </p>
      </div>
    </main>
  );
}
