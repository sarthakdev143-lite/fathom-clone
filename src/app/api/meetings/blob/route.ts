import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { isUploadConfigured } from "@/lib/config";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";

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
 * 200 MB is roughly nine hours of MediaRecorder Opus, or about 18 minutes of
 * uncompressed 48 kHz stereo WAV. Provider upload caps no longer apply here:
 * audio over 14 MB is split into chunks server-side before transcription (see
 * `src/lib/transcribe.ts`). The bound that remains is the function's /tmp
 * space, which holds the source file while it is split.
 */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

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

  // Only token minting is limited; it is the call that authorises storage.
  if (body.type === "blob.generate-client-token") {
    const limited = await rateLimit(request, RATE_RULES.uploadToken);
    if (limited) return limited;
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
      // No onUploadCompleted: the meeting row is only created once the client
      // reports the URL, so there is nothing to reconcile server-side, and an
      // empty callback makes Vercel warn about a missing callback URL.
    });

    return Response.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown upload error.";
    return Response.json({ error: message }, { status: 400 });
  }
}
