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
| 7 | Gemini fallback | Verified in production by deleting `GROQ_API_KEY` from Vercel and re-running: transcription and summary both completed via Gemini. |
| 8 | Transcription accuracy | Measured at 99.1% WER 0.9% on a 128s two-speaker, 15-turn recording with injected noise. `whisper-large-v3-turbo` and full `whisper-large-v3` scored identically; Gemini scored 99.7%. |
| 9 | Playback | Recorded WebM played with its Infinity duration fixed; click-to-seek, follow/pause, `?t=` and copy-link verified locally and in production. |
| 10 | Search | FTS5 across ready meetings; LIKE fallback. Debounce, highlight, `?t=` links verified in a browser. |

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
| `GROQ_API_KEY` | steps 2 and 3 | Primary provider. |
| `GEMINI_API_KEY` | optional | Fallback provider, used only when Groq fails. |
| `GEMINI_TRANSCRIBE_MODEL` | optional | Defaults to `gemini-3.5-transcribe`. |
| `GEMINI_SUMMARY_MODEL` | optional | Defaults to `gemini-3.5-flash`. |
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

## Provider fallback

Groq is the primary for both transcription and summarization. Gemini is a
fallback so a Groq outage degrades the product instead of breaking it. Selection
lives in one place, `src/lib/providers.ts`, and the routes are unchanged.

**What triggers a fallback** - only failures that are the provider's fault: 401,
403, 429, 5xx, and a missing key. A 400 is *not* retried, because retrying a
rejected request against a second provider turns one user error into two billable
calls. Verified: a simulated Groq 503 and 429 both fall through to Gemini, and a
simulated 400 does not.

**Verified in production by actually removing the key.** `GROQ_API_KEY` was
deleted from Vercel, the app redeployed, and a full recording ran end to end:

| | Groq present | Groq removed |
| --- | --- | --- |
| Transcription provider | `groq`, 6 segments | `gemini`, 0 segments |
| Fallback reason | - | `GROQ_API_KEY is not set` |
| Summary | produced | produced |
| Detail page | no note | "Transcribed by the Gemini fallback" |

`transcript_provider` and `transcript_fallback_reason` are stored on the meeting
so a fallback is visible rather than silent.

**The two providers are not equivalent**, and pretending otherwise would be
misleading:

- **No timestamps.** `gemini-3.5-transcribe` returns one block of text with no
  word or segment timings. The live chunk path therefore emits one caption per
  slice rather than Whisper's finer segmentation, and `key_moments` cites slice
  boundaries. The caption is still correct; only the internal split is missing.
- **The response shape is unusual.** The transcript arrives as
  `part.audioTranscription.text`, and `part.text` on the same part is empty.
  Reading `text` reports a blank transcript for a call that consumed the audio
  successfully. This cost a debugging cycle and is now asserted in a test.
- **Slower.** A 32-minute file took 83s, against roughly 18s for Whisper.
- **14 MB inline ceiling.** Verified working at 14.5 MB of base64. Larger audio
  is refused with an explicit message rather than an opaque 400; covering it
  would mean the Files API.

**Summarization falls back too**, to `gemini-3.5-flash` with
`responseMimeType: application/json`. This goes slightly beyond a transcription
fallback, but the chat endpoint is the one that rate-limits hardest, and without
it a Groq outage would leave meetings with a transcript and no summary - which is
not a degraded product, just a broken one with extra steps.

**`gemini-3.5-transcribe-live` is deliberately not used.** It exists, but only
through the Live API's stateful WebSocket. A Vercel function cannot hold one open
for the length of a meeting, which is the same limit that ruled out SSE. Live
captions use the unary model, one call per slice, and therefore keep the
rate-limit backoff and 20-minute ceiling described in known limit 3. Running the
real Live API would need a browser-to-Google WebSocket, which puts the API key in
client-visible code and in the network tab of every user. That is a real decision
with a real security cost, not something to slip in, so it is not implemented.

## Capture sources

A microphone records one side of a call. Remote participants arrive as WebRTC
*output* and are played through the speakers, never routed back into the input
device, so a mic-only recording of a call contains half the conversation. Two
options are offered in the capture panel, and what was actually captured is
recorded rather than assumed:

- **Record this tab's meeting audio** (default) - captures the tab playing the
  meeting *and* the microphone, so both sides are in the file.
- **Record microphone only** - for solo notes. The raw mic stream is recorded
  directly, with no AudioContext in the path, so a failure to start one cannot
  regress solo recording.

The two sources are summed through the Web Audio API - two
`MediaStreamAudioSourceNode`s into a mix bus, feeding one
`MediaStreamAudioDestinationNode` - and that single stream is what MediaRecorder
records. The mixed stream is also what the live caption tap reads, so live
captions now cover the remote side too. Downstream it is just an audio file, so
the transcribe and summarize pipeline is untouched.

The mix never reaches `AudioContext.destination`. Routing tab audio back to the
speakers while that same tab is playing it is a feedback loop, so the bus feeds
the recording destination and a muted gain that exists only to keep the graph
processing.

**Verified by running the real app**, with only the browser's share-tab picker
shimmed so the shipping code path executed end to end. Two different speakers
were used, one on each source, and the resulting transcript interleaves them:

> "Thanks everyone for joining" (mic) … "Did the load test finish?" (tab) … "I
> have been waiting on those numbers all week" (tab) … "the main item is the Q3
> launch date" (mic) … "The P99 latency was the thing I was worried about" (tab)

Mic-only was re-tested the same way and still records the raw stream, reports
`microphone only`, and never calls `getDisplayMedia`.

**Failure modes that are handled explicitly**, because each one silently
produces a half-transcript if ignored:

| Situation | Behaviour |
| --- | --- |
| Picker cancelled | Nothing recorded, microphone released, message shown. |
| "Also share tab audio" left unticked | Refused with instructions, rather than recording mic only. |
| Browser cannot share tab audio | Option disabled, mic-only offered. |
| Sharing stopped mid-recording | Recording continues on the mic and a notice says so. |

**Not covered, and cannot be from a web page.** Native meeting apps, and the
OS-level mixers a desktop tool would use. A Zoom or Teams desktop app plays its
audio through a native window, so there is no tab to capture; and system loopback
(WASAPI on Windows, BlackHole on macOS, PulseAudio monitor on Linux) is not
reachable from browser JavaScript at all. Someone on a native app still has to
use the microphone option, a second device, or a desktop application. This is a
platform boundary, not an oversight.

## Playback

The detail page plays the stored recording, and every transcript line and key
moment seeks it. The playing line is highlighted and kept in view inside the
transcript box - never by scrolling the page, so a reader in the summary is not
dragged down. Scrolling the transcript by hand (wheel, touch, keyboard, or the
scrollbar) pauses that until "Follow playback" is pressed or a line is clicked.
`?t=SECONDS` opens the page at that point, highlighted and on screen but not
playing, and each key moment has "Copy link to this moment". The page is still a
server component; a small client provider shares one audio element between the
player, the key moments and the transcript without moving them in the layout.

**MediaRecorder WebM files report their duration as Infinity in Chrome.** They
have no Duration element and no Cues, so the native scrubber cannot be dragged.
This was measured before building anything: a 12-second recording loaded with
`duration = Infinity`. The player seeks far past the end once on load, which makes
the browser scan to the last cluster and learn the real length, then restores the
intended position. The highlight is frozen while that happens, or it would flash
the final line. Blob storage answers Range requests with `206 Partial Content`,
which is what lets remote seeking work at all.

Degradation depends on how the meeting was made, so the note is chosen on the
server:

| Meeting | Player | Lines and moments |
| --- | --- | --- |
| Recorded or uploaded | shown | seek the audio |
| Seeded demo | hidden, with a note | still jump to and highlight the transcript line |
| Recorded before playback existed | hidden, with a note | still jump to the line |
| Gemini transcript (no timings) | shown, with a note | not clickable; moment timestamps hidden |

The last row hides the timestamps rather than just disabling them. Without
segment offsets the summarizer had nothing to ground key moments in, so those
times are guesses, and showing them as if they could be jumped to would be
misleading.

`audio_url` is validated against the Vercel Blob host pattern again at render time,
since it ends up in an `<audio src>`. A deleted blob shows "The recording could not
be loaded" instead of a silent broken player.

**Verified in a browser, locally and in production**, against a recording made
through the UI so the WebM fix ran on the real format: duration Infinity fixed to
50.16s; clicking a line at 0:26 landed at 26.79 and started playback; the
highlight advanced during playback; wheel-scrolling paused auto-scroll while the
highlight kept moving and the scroll position held still; "Follow playback"
brought the line back; `?t=33.98` opened at exactly 33.98 without playing; copied
links carried the exact moment (`?t=9.64`); `?t=abc`, `-5` and `99999` all
rendered safely; and the seeded, pre-playback and Gemini cases each showed their
own note with the right controls enabled.

## Search

The dashboard has one box over titles, summary fields and transcript text,
across ready meetings only. Results are grouped by meeting with up to three
labelled hits each (Title, Topic, Action, Transcript …); transcript hits link
to `/meetings/:id?t=SECONDS` at the matching segment start, everything else
links plainly. Input is debounced 250 ms with in-flight requests aborted, an
empty query restores the full list, and no matches render a named no-results
card. The endpoint is read-only and makes no model calls.

**FTS5 where available, LIKE otherwise.** `meeting_fts` (porter tokenizer,
`meeting_id` unindexed) is created lazily with insert/delete/update triggers
plus a backfill for pre-existing rows, so it never blocks startup on an
SQLite without the FTS5 module — in that case, and if the MATCH query ever
throws, the same tokens run as LIKE with a `LIMIT 20`. Both paths share one
snippet builder, so the two modes render identically. Queries are capped at
200 characters, ten tokens, twenty meetings; single-character tokens are
dropped because they match everything. Snippets are plain text sliced on code
points and snapped to word boundaries, and matches render in `<mark>` via a
split, never `innerHTML`, so meeting content cannot inject markup.

**Verified in a browser**: 8 fast keystrokes → 1 request; 3 groups, 7
highlights; transcript hit → detail at `?t=`; gibberish → no-results naming
the query; clearing restores the 5-card list; no page errors. The LIKE query
was verified directly against SQL; the FTS path served every check above with
`"mode":"fts"`.

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

**8. No audio playback for meetings recorded before blob storage.** Those rows kept
their audio in the `audio_blob` column, and playback reads `audio_url` only, so
the one such meeting ("Q3 checkout planning sync") shows a note instead of a
player. Serving the legacy column would need a small streaming endpoint.

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

**Transcription was never the weak link; capture was.** Accuracy measured at
99.1% WER 0.9% on a noisy two-speaker recording, so a transcript that reads
wrongly is usually a recording that never contained the audio. The first
measurement taken during this work appeared to show 45% error and turned out to
be a broken test harness, not a model problem - three independent models agreed
on the same divergences, which is what gave it away. If a transcript looks
wrong, check the source indicator first: `Tab audio + microphone` versus
`Microphone only`.

**Switching to the full `whisper-large-v3` model would not improve accuracy.**
Measured identical to the turbo model at 99.1% on the same audio, so there is no
reason to spend 6x the latency for it.

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

Also not built, as instructed until 1–5 were working: live streaming,
anything beyond the assigned scope. (Search has since been built; see above.)
