import type { NextConfig } from "next";

// Domínio oficial (com www). Quem abrir sem "www" é redirecionado para ele: o login (cookie) é por
// domínio, então manter um endereço só evita "logado num, deslogado no outro" e QR com link diferente.
const SITE_HOST = new URL(process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://www.jcsistema.online").host;
const BARE_HOST = SITE_HOST.replace(/^www\./, "");

const nextConfig: NextConfig = {
  // `next build` gera um servidor Node.js autocontido em .next/standalone,
  // pronto para publicar (Vercel, Hostinger, VPS, etc.) sem precisar de build extra.
  output: "standalone",
  poweredByHeader: false,
  env: { NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://www.jcsistema.online" },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
      ],
    }];
  },
  async redirects() {
    if (BARE_HOST === SITE_HOST) return [];
    return [{ source: "/:path*", has: [{ type: "host", value: BARE_HOST }], destination: `https://${SITE_HOST}/:path*`, permanent: true }];
  },
};

export default nextConfig;
