import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray lockfile in a parent directory makes
  // Turbopack infer the wrong root and fail the build on a clean host.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;
