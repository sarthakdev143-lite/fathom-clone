import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { isUploadConfigured } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints the short-lived client token that lets a browser upload audio straight
 * to blob storage.
 *
 * This endpoint never receives the audio itself. The client asks for a token
 * here, then PUTs the bytes directly to Vercel Blob, so a long recording never
 * passes through a serverless function and is not subject to the 4.5 MB request
 * body limit.
 */

/**
 * 100 MB is roughly three and a half hours of Opus at typical MediaRecorder
 * bitrates. It is a storage sanity bound, not the real constraint: Groq's
 * transcription endpoint caps audio at 25 MB (see `src/lib/groq.ts`), so a
 * recording larger than that will upload successfully and then be rejected at
 * the transcription step.
 */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

/**
 * Explicit allowlist. `allowedContentTypes` is matched against the content type
 * the client declares, and the client normalises `audio/webm;codecs=opus` down
 * to `audio/webm` before asking for a token, so bare types are listed here
 * rather than parameterised ones.
 */
const ALLOWED_CONTENT_TYPES = [
  "audio/webm",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/oga",
  "audio/flac",
  "audio/x-flac",
  "audio/3gpp",
  "video/webm",
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
];

export async function POST(request: Request) {
  if (!isUploadConfigured) {
    return Response.json(
      {
        error:
          "Blob storage is not configured. BLOB_READ_WRITE_TOKEN is not set, " +
          "so the browser cannot be given an upload token.",
      },
      { status: 503 },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json(
      { error: "Expected a JSON upload request." },
      { status: 400 },
    );
  }

  try {
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_AUDIO_BYTES,
        // Keeps two users uploading "recording.webm" from colliding.
        addRandomSuffix: true,
        // Meeting audio should not be cached by any CDN in the path.
        cacheControlMaxAge: 0,
      }),
      onUploadCompleted: async () => {
        // Deliberately empty. Access is decided when the meeting row is created,
        // so there is nothing to reconcile here. A real deployment would want
        // to prune blobs that never became a meeting.
      },
    });

    return Response.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown upload error.";
    return Response.json({ error: message }, { status: 400 });
  }
}
