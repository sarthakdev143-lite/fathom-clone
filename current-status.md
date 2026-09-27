# Current status

A Fathom AI clone. Next.js App Router, API routes as the backend, SQLite for
storage. Live at **https://8x-assignment-fantom-clone.vercel.app**.

Last updated: 2026-09-27.

## Short answer: nothing is left unfinished

All five assigned steps are built, tested against the real APIs, and deployed.
Bot-based meeting joining is stubbed as instructed. Three defects that were
blocking a clean handover were found and fixed after the steps were done, so the
tree is clean and green.

## What is done, and how it was verified

| # | Step | Verification |
|---|------|--------------|
| 1 | Audio capture | Real Chromium with a synthetic mic: 4s recording → 58 KB webm → 66 KB body reached the server. Rejection paths return 400 / 413 / 415. |
| 2 | Transcription | Real speech audio → 53s, 630 chars, 14 timestamped segments, 3.9s via `whisper-large-v3-turbo`. |
| 3 | Summarization | One call, ~3s. 13/13 adversarial parser cases pass. |
| 4 | Dashboard + detail | Both render, unknown id → 404. |
| 5 | Seed | 4 meetings summarised through the real pipeline. 23/23 key moments land exactly on real segment starts. |

The pipeline was also run end to end **against the production deployment**:
2.24 MB upload → 201, transcribe 3.9s, summarize 3.2s, detail page 200.

## Architecture notes

**Storage is SQLite in both environments.** `@libsql/client` speaks the SQLite
wire protocol, so only the URL changes: `file:./data/app.db` in development,
`libsql://…turso.io` on Vercel. A plain SQLite file cannot be used on Vercel
because the serverless filesystem is read-only and does not persist between
invocations.

**Audio bytes are retained as a BLOB.** The first version of the upload discarded
them, which left Whisper with nothing to transcribe. Keeping them makes
transcription an independently retryable step rather than something welded onto
the upload request.

**Schema changes are forward-only migrations** recorded in `_migrations`
(`src/lib/db.ts`). The initial `CREATE TABLE` is the version 0 shape and is
never edited; later columns arrive via `ALTER`.

**The pipeline is a series of small states**, not one long request:
`uploaded → transcribing → transcribed → summarizing → ready`, with `failed` as
a terminal state carrying `status_error`. Each stage can be re-run on its own.

## Environment variables

| Variable | Required for | Notes |
|----------|--------------|-------|
| `TURSO_DATABASE_URL` | any persistence | Falls back to a local SQLite file in development. Required on Vercel. |
| `TURSO_AUTH_TOKEN` | remote database | |
| `GROQ_API_KEY` | steps 2 and 3 | |
| `SUMMARY_MODEL` | optional | Defaults to `openai/gpt-oss-120b`. |

If a variable is missing in production the app renders a setup notice naming the
variable instead of throwing a 500, and the write APIs return 503.

## Commands

```bash
npm install
npm run dev        # http://localhost:3000
npm run db:seed    # re-seeds; makes live Groq calls, so it costs quota
npm run check      # typecheck + lint + build
```

## Known limits, deliberately not addressed

These are all outside the assigned steps 1–5 and were left alone on purpose.

**1. Vercel's 4.5 MB request-body cap.** Roughly 20 minutes of Opus audio. Longer
recordings fail with a platform error rather than the app's own validation
message, because the platform rejects the request before the route handler runs.
The code cap is 25 MB (`src/app/api/meetings/route.ts:12`). The fix is chunked
upload, which changes both the client and the API.

**2. No retry affordance for a failed meeting.** The detail page is read-only, so
a meeting stuck in `failed` has to be re-driven from the record page. Both
`transcribe` and `summarize` are safely re-runnable; only the UI affordance is
missing.

**3. No audio playback.** Audio is stored and retained, but there is no endpoint
to stream it back. Out of scope for the five steps.

**4. `npm run db:seed` calls the live Groq API** four times. It also deletes
existing `source = 'seed'` rows first, which makes it idempotent but not
free.

**5. The summariser is not retried at the parse layer.** Rate limits and 5xx are
retried with backoff, and malformed JSON is parsed defensively, but if the model
returns valid JSON of the wrong shape the meeting is marked `failed` and needs a
manual re-run.

## Things that will surprise you

**`llama-3.3-70b-versatile` no longer exists on Groq.** It was retired between
this being written and being run. The model id is env-overridable for that
reason. Only `gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b` and the whisper models
were available to the key used here.

**Whisper hallucinates on non-speech audio.** A pure tone comes back as `"."`, not
an empty string, so an emptiness check is not enough. `looksLikeSpeech()` in
`src/lib/groq.ts` screens on alphanumeric content and characters-per-second;
without it, step 3 would confidently summarise audio containing no meeting.

**Many action items have `owner: null`, and that is correct.** First-person
commitments ("I'll do the index migration") have no name in the audio, and the
prompt forbids inventing one. The model is choosing `null` over guessing.

**An empty `decisions` array is often right.** A meeting that sets a deadline to
decide something later has not decided anything yet. The prompt says so
explicitly to stop the model manufacturing decisions from discussion.

## Not built, on purpose

Bot-based Zoom / Google Meet / Teams joining. `src/lib/bot-join.ts` is a stub
whose single exported function always throws — there is no mock success path,
because a stub that returns fake data reads as a working feature. The file
documents the five hard parts if it is ever built for real. The UI exposes it as a
disabled control labelled "does nothing".

Also not built, as instructed until 1–5 were working: search, live streaming,
anything beyond the assigned scope.
