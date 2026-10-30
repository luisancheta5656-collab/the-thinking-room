import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server in .next/standalone, which the Windows app bundles.
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // Hide the Next.js dev badge, which overlaps the sidebar in the app window.
  devIndicators: false,
};

export default nextConfig;
