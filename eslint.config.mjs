import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// eslint-config-next v16 ships a native flat config that already includes the
// TypeScript rules and the default ignore list, so it is used directly rather
// than through the legacy FlatCompat bridge.
const config = [
  ...nextCoreWebVitals,
  {
    ignores: [".opencode/**", ".vercel/**", "data/**", "next-env.d.ts"],
  },
];

export default config;
