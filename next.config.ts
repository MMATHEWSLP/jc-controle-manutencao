import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next build` gera um servidor Node.js autocontido em .next/standalone,
  // pronto para publicar (Vercel, Hostinger, VPS, etc.) sem precisar de build extra.
  output: "standalone",
};

export default nextConfig;
