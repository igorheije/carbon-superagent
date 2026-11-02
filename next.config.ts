import path from "node:path";
import type { NextConfig } from "next";

const root = path.resolve(__dirname);

const nextConfig: NextConfig = {
  // Pin the workspace root so a lockfile in a parent folder never changes tracing.
  outputFileTracingRoot: root,
  // Lets a production build live next to a running `next dev` without sharing .next.
  distDir: process.env.CARBON_DIST_DIR ?? ".next",
  turbopack: { root },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
