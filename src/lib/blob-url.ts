/**
 * Validation for the blob URL the client hands back after uploading.
 *
 * This is a security boundary, not a formality. The transcription route fetches
 * `audio_url` from the server, so an unvalidated URL would let anyone POST
 * something like `http://169.254.169.254/latest/meta-data/` and have the app
 * fetch internal cloud metadata and hand the bytes to a model. Only URLs that
 * genuinely point at the configured blob store are accepted.
 */

/** The host suffix Vercel Blob serves public blobs from. */
const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/** `https://<store>.public.blob.vercel-storage.com/<path>` */
const BLOB_URL_PATTERN =
  /^https:\/\/[a-z0-9][a-z0-9-]{0,61}\.public\.blob\.vercel-storage\.com\/[A-Za-z0-9._\-/]+$/;

/**
 * Accepts a URL only if it is an https Vercel Blob URL.
 *
 * The store id in the hostname is not compared against a configured value
 * because the app can legitimately be pointed at any store via
 * BLOB_READ_WRITE_TOKEN; the guarantee that matters is that the host is a
 * Vercel Blob host, which cannot resolve to an internal address.
 */
export function isTrustedBlobUrl(value: unknown): value is string {
  return typeof value === "string" && BLOB_URL_PATTERN.test(value);
}

export function assertTrustedBlobUrl(value: unknown): string {
  if (!isTrustedBlobUrl(value)) {
    throw new Error(
      "audio.url must be an https URL on a Vercel Blob host " +
        `(expected something like https://<store>${BLOB_HOST_SUFFIX}/<path>).`,
    );
  }
  return value;
}
