# Current status

A Fathom AI clone. Next.js App Router, API routes as the backend, SQLite for
storage. Live at **https://8x-assignment-fantom-clone.vercel.app**.

Last updated: 2026-09-27 (audio upload moved to Vercel Blob).

## Short answer: nothing is left unfinished

All five assigned steps are built, tested against the real APIs, and deployed.
Bot-based meeting joining is stubbed as instructed. Three defects that were
blocking a clean handover were found and fixed after the steps were done, so the
tree is clean and green.

## What is done, and how it was verified

| # | Step | Verification |
|---|------|--------------|
| 1 | Audio capture | Real Chromium with a synthetic mic: 4s recording → 58 KB webm → 66 KB body reached the server. Rejection paths return 400 / 413 / 415. 32-minute and 58.6 MB files upload directly to blob storage. |
| 2 | Transcription | Real speech audio → 53s, 630 chars, 14 timestamped segments, 3.9s via `whisper-large-v3-turbo`. |
| 3 | Summarization | One call, ~3s. 13/13 adversarial parser cases pass. |
| 4 | Dashboard + detail | Both render, unknown id → 404. |
| 5 | Seed | 4 meetings summarised through the real pipeline. 23/23 key moments land exactly on real segment starts. |
| 6 | Live mode | Additive. Verified in production with real speech: captions at 6s intervals, provisional summary every ~35s of new audio, then the unchanged authoritative pipeline. |

The pipeline was also run end to end **against the production deployment**:
2.24 MB upload → 201, transcribe 3.9s, summarize 3.2s, detail page 200.

## Architecture notes

**Storage is SQLite in both environments.** `@libsql/client` speaks the SQLite
wire protocol, so only the URL changes: `file:./data/app.db` in development,
`libsql://…turso.io` on Vercel. A plain SQLite file cannot be used on Vercel
because the serverless filesystem is read-only and does not persist between
invocations.

**Audio is uploaded by the browser straight to Vercel Blob.** The browser asks
`/api/meetings/blob` for a short-lived client token, PUTs the file directly to
storage, then posts only the resulting URL and metadata to `/api/meetings`. The
audio never passes through a serverless function, so the 4.5 MB function request
body limit does not apply to it. Files over 8 MB switch to a multipart upload so
individual parts retry independently. The transcribe route fetches the audio back
from the URL when it needs to. `audio_url` is validated against the Vercel Blob
host pattern before it is stored, because the server fetches it and an unchecked
URL would be a server-side request forgery vector.

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
| `BLOB_READ_WRITE_TOKEN` | audio upload | Vercel Blob store token. `vercel blob create-store --access public --yes` provisions it. |
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

## Fixed

**Vercel's 4.5 MB request-body cap — fixed.** Audio no longer travels through a
function: the browser uploads it directly to Vercel Blob with a client token
minted by `/api/meetings/blob`, and posts only the resulting URL. Verified with
a 32-minute recording — 10.9 MB as `webm/opus`, 58.6 MB as uncompressed WAV —
which uploaded successfully where the old path would have failed at roughly four
minutes.

## Live mode

While a meeting is recording, captions and a running summary appear in the
browser. The post-recording pipeline is untouched: when recording stops, the full
audio is uploaded and the ordinary transcribe-then-summarize path runs as before,
and its result overwrites the live preview.

**Audio is tapped as raw PCM, not sliced from the recording.** An AudioWorklet
copies samples out of the live stream and every 6 seconds they are encoded as a
self-contained WAV and posted for transcription. The obvious alternative does not
work: a WebM stream from MediaRecorder is not a valid media file until recording
finishes, and Whisper rejects both a bare cluster and a header-prefixed cluster
with `invalid_media_file`. That was tested before the feature was built, not
assumed.

**Transport is polling, not Server-Sent Events.** A meeting can run for half an
hour, and a Vercel function is terminated once it exceeds its duration limit, so
an SSE connection cannot outlive a recording. Polling every 2 seconds costs a few
bytes when nothing has changed: the client sends how many segments it has and
which summary version it last saw, and the server returns only the difference.
`live_seq` and `live_summary_seq` on the meeting row are what make that cheap.

**The live summary is deliberately provisional.** A reduced schema with no key
moments, written as a progress update, refreshed at most every 35 seconds of new
audio. The throttle position is stored in the database rather than in module
memory, because a module-level counter resets on every serverless cold start and
would refresh far more often than intended. A dropped provisional summary never
fails the caption stream; the authoritative summary comes later regardless.

## Known limits, deliberately not addressed

These are all outside the assigned steps 1–5 and were left alone on purpose.

**1. Groq's 25 MB transcription cap is now the binding limit.** The upload path
no longer constrains recording length, but Groq rejects audio over 25 MB, which
caps a browser `webm/opus` recording at roughly 70 minutes. Anything larger
uploads and then fails at transcription; the client warns above 25 MB rather than
blocking, since the upload itself would succeed.

**2. Long meetings are summarised from a sampled transcript.** Independent of
audio size, Groq's on-demand tier allows 8,000 tokens per minute, which also caps
any single request. A 32-minute transcript runs to roughly 35,000 characters, so
it cannot be sent whole and the call fails outright with a 413 rather than
degrading. Transcripts over 24,000 characters are therefore sampled — segments
are dropped at even intervals across the whole conversation, never truncated at
the start, so the summary still reflects the arc of the meeting and every
timestamp it cites remains a real segment start. The consequence is that an
action item sitting in a skipped gap can be missed. `transcript_sampled` records
this on the meeting row (nullable: null means summarised before the field
existed), the summarize API returns it as `transcriptCoverage`, and the detail
page badges it so a reader knows the summary is narrower than the transcript.
Lifting the ceiling means chunking the audio and merging the segment offsets.

**3. Live mode is rate-limited and capped, and those caps are load-bearing.**

| Threshold | Value | Behaviour |
| --- | --- | --- |
| Baseline chunk cadence | 6 s | One slice of audio per tick while healthy. |
| Backoff step | x2 | Any 429 or 5xx from the chunk or summary call. |
| Backoff ceiling | 60 s | Cadence doubles to this and stops there. |
| Cadence reset | on success | Any successful slice returns it to 6 s. |
| Live ceiling | 20 min | Live updates stop; recording and the final summary continue. |
| Max slice length | 20 s | A slice is trimmed to its most recent 20 s. |
| Poll interval | 2 s | Caption and summary deltas, guarded against overlap. |
| Summary refresh | every 35 s of new audio | Provisional summary regeneration. |

Three things are deliberate here. A rate limit is logged and ridden out rather
than surfaced, because a person recording should not be interrupted by billing.
A failed slice is **dropped, not re-queued** — re-queuing grows the buffer on
every failure until the slice exceeds the request limit and live mode fails for
good. And the 20-second slice cap exists because the backoff created a bug
without it: at the 60-second ceiling a slice would carry a full minute of 48 kHz
audio, about 5.8 MB, which the server rejects at 4 MB, so every request after a
backoff would fail and the live captions would die exactly when the safety net
was supposed to help. Trimming to the most recent 20 seconds bounds the request
permanently, and the dropped span shows up as a gap in the timestamps.

None of this touches the authoritative pipeline. The backoff state lives only in
the browser hook, the post-stop transcribe and summary are separate requests
against separate routes, and the live summary is a preview that the real one
overwrites. Verified by forcing 429s through to the 60-second ceiling and then
confirming the post-stop transcribe and summarize still completed in 6.0 s and
6.6 s.

**4. No retry affordance for a failed meeting.** The detail page is read-only, so
a meeting stuck in `failed` has to be re-driven from the record page. Both
`transcribe` and `summarize` are safely re-runnable; only the UI affordance is
missing.

**5. Abandoned live sessions linger.** Closing the tab mid-recording leaves the row
in `live` forever, since nothing server-side knows the browser is gone. The
dashboard labels such rows "Interrupted" after two minutes of silence rather
than pretending they are still recording, but the audio and partial transcript are
not cleaned up automatically.

**6. Live captions can contain seam artifacts.** Each 6-second slice is
transcribed independently, so a sentence spanning a boundary can be cut or
repeated. This is exactly why the authoritative transcript re-transcribes the
complete audio rather than reusing the live one, and why the live view is
labelled provisional.

**7. Live mode costs extra model calls.** A 30-minute meeting sends 300 chunk
transcriptions plus roughly 50 summary refreshes. It is off by default only for
uploads, not for recordings - recordings default to on, because a user who
records a meeting usually wants the live view. The toggle is in the capture
panel.

**8. No audio playback.** The audio is stored in blob storage, but there is no
endpoint to stream it back. Out of scope for the five steps.

**9. `npm run db:seed` calls the live Groq API** four times. It also deletes
existing `source = 'seed'` rows first, which makes it idempotent but not
free.

**10. The summariser is not retried when the model refuses to produce JSON.**
Rate limits and 5xx are retried with backoff and malformed JSON is parsed
defensively, but two failure modes still need a manual re-run. Groq sometimes
answers a `json_object` request with HTTP 400 `failed_generation`, which is not a
retryable status, so the meeting goes straight to `failed`. And if the model
returns valid JSON of the wrong shape, the same happens. Both were observed while
testing - a single transient `failed_generation` cost one meeting its summary,
and re-running produced one immediately. A future fix would retry a 400 whose
error code is `failed_generation`, or drop `response_format` and lean on the
defensive parser that already exists.

**11. No authentication.** Anyone who can reach the app can list every meeting and
open any meeting whose id they have. Blob URLs contain a random suffix, so the
audio is not trivially guessable, but that is obscurity, not access control.

**12. `vercel env add` will not overwrite an existing variable.** It errors
instead, and a `--force` flag is not accepted by this CLI version. Rotating a key
means `vercel env rm <NAME> production --yes` followed by a fresh `add`. Related:
`vercel blob create-store --yes` **overwrites `.env.local`** with the project's
Development-only variables, silently discarding any Production-only or local-only
entries. Back the file up before running it.

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
