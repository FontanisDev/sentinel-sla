import type { NextConfig } from "next";

// Security headers live in src/proxy.ts (single source of truth): the proxy
// sets them on EVERY response with a per-request CSP nonce, and gates HSTS on
// SENTINEL_TLS. The old headers() block here was unconditional (HSTS without
// TLS declared) and is superseded.
//
// allowedDevOrigins: next 16.4 blocks "cross-origin" dev resources (HMR, dev
// chunks) by default — hitting the dev server via 127.0.0.1/localhost or a
// LAN hostname silently breaks client hydration. Allow the standard hosts.
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
