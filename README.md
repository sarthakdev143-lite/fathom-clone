# Fathom clone

Record a meeting, get a transcript and a summary — live at
**https://8x-assignment-fantom-clone.vercel.app**

Records audio from the browser microphone, a tab playing a meeting, or an
uploaded file, showing live captions and a running summary while recording.
Transcribes with Groq Whisper (falling back to Gemini), then summarises into a
TL;DR, topics, decisions, action items and timestamped key moments. The
dashboard has a search box over titles, summary fields and transcript text,
with hits that deep-link to the matching moment.

## Quickstart

Needs Node 20.9+.

```bash
npm install
```

Set `GROQ_API_KEY` (transcription and summarization), `BLOB_READ_WRITE_TOKEN`
(audio storage), `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env.local`.
`GEMINI_API_KEY` is optional: a fallback used only when Groq fails. The Turso
pair is optional in development, which uses a local SQLite file.

```bash
npm run dev
```

Open http://localhost:3000. `npm run db:seed` adds four example meetings.

```bash
npm test        # automated tests; no keys needed, never touches .env.local
npm run check   # typecheck + lint + test + build (what CI runs)
```

Recordings of any length work: audio over 14 MB is split with ffmpeg
(bundled via `ffmpeg-static`) and long transcripts are summarised in windows,
both resumable across requests. On Vercel, set `CRON_SECRET` so the daily
cleanup cron runs. Meeting pages offer transcript export (Markdown, text, SRT)
and a question box that answers from the transcript with timestamped citations.

## Deliberately not built

- Bot-based Zoom / Meet / Teams joining
- Live streaming of finished meetings
- Gemini's WebSocket Live API, which would put the API key in the browser

See [current-status.md](./current-status.md) for why, and for verification,
architecture, live mode, the bugs found, and known limits.
