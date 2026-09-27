import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Audio uploads are forwarded straight to Groq from the API route, so nothing
  // large ever lands in the Next.js request body limit during build or serve.
};

export default nextConfig;
