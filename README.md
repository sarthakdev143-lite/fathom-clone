# Fathom clone

Record a meeting, get a transcript and a summary — live at
**https://8x-assignment-fantom-clone.vercel.app**

Records audio from the browser microphone or an uploaded file, showing live
captions and a running summary while recording. Transcribes with Groq Whisper,
then summarises into a TL;DR, topics, decisions, action items and timestamped key
moments, listed on a dashboard with a detail page each.

## Quickstart

Needs Node 20.9+.

```bash
npm install
```

Set `GROQ_API_KEY` (transcription and summarization), `BLOB_READ_WRITE_TOKEN`
(audio storage), `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env.local`.
The Turso pair is optional in development, where a local SQLite file is used.

```bash
npm run dev
```

Open http://localhost:3000. `npm run db:seed` adds four example meetings and
makes live Groq calls.

## Deliberately not built

- Bot-based Zoom / Meet / Teams joining
- Search
- Live streaming

See [current-status.md](./current-status.md) for why.

## Deep dive

[current-status.md](./current-status.md) covers verification, architecture
rationale, the bugs found, and known limits.
