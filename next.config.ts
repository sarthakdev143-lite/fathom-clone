import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Audio never passes through a function body: the browser uploads straight
  // to Vercel Blob. See src/app/api/meetings/blob/route.ts.

  // ffmpeg-static resolves its binary relative to its own __dirname, which
  // breaks once bundled. Leaving it external keeps the real path, and the
  // tracing include ships the binary (never `require`d, so not auto-traced)
  // with the one function that runs it.
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/meetings/*/transcribe": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
    ],
  },
};

export default nextConfig;
