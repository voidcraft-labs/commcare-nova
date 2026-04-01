import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Standalone output for containerized deployments (Cloud Run, Docker). */
  /* Produces a self-contained build with only necessary node_modules. */
  output: "standalone",
};

export default nextConfig;
