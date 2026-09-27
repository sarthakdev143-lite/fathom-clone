import Link from "next/link";
import Recorder from "@/components/Recorder";

export default function RecordPage() {
  return (
    <main>
      <h1>Record a meeting</h1>
      <p className="lede">
        Capture audio from your microphone, or upload a file you already have.
      </p>
      <Recorder />
      <p className="muted small" style={{ marginTop: "2rem" }}>
        <Link href="/">&larr; Home</Link>
      </p>
    </main>
  );
}
