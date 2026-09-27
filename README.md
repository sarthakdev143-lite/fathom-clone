# Fathom clone

Record a meeting, get a transcript and a summary — live at
**https://8x-assignment-fantom-clone.vercel.app**

Records audio from the browser microphone or an uploaded file, showing live
captions and a running summary while recording. Transcribes with Groq Whisper,
then summarises into a TL;DR, topics, decisions, action items and timestamped key
moments, on a dashboard with a detail page per meeting.

## Quickstart

Needs Node 20.9+.

```bash
npm install
```

Set `GROQ_API_KEY` (transcription and summarization), `BLOB_READ_WRITE_TOKEN`
(audio storage), `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env.local`.
`GEMINI_API_KEY` is optional and used only when Groq fails. The Turso pair is
optional in development, which uses a local SQLite file.

```bash
npm run dev
```

Then http://localhost:3000. `npm run db:seed` adds four example meetings.

## Deliberately not built

- Bot-based Zoom / Meet / Teams joining
- Search
- Live streaming of finished meetings

See [current-status.md](./current-status.md) for why.

## Deep dive

[current-status.md](./current-status.md) — verification, architecture, live mode,
bugs found, known limits.
