import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Fathom clone</h1>
      <p className="lede">
        Record a meeting, get a transcript and a summary.
      </p>

      <div className="row">
        <Link className="btn btn-primary" href="/record">
          Record a meeting
        </Link>
      </div>

      <div className="card" style={{ marginTop: "1.5rem" }}>
        <strong>Build status</strong>
        <ul className="muted small" style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
          <li>Audio capture (mic recording + file upload) — working</li>
          <li>Transcription — next</li>
          <li>Summarization — next</li>
          <li>Dashboard and meeting detail — next</li>
        </ul>
      </div>
    </main>
  );
}
