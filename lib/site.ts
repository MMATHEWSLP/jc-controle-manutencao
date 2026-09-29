// Endereço oficial do sistema. Usado nos links de QR Code, nas mensagens de WhatsApp, nos
// metadados da página e para conferir a origem das requisições. Configure SITE_URL no servidor
// (NEXT_PUBLIC_SITE_URL no build, para as telas) se o domínio mudar.
export const DEFAULT_SITE_URL = "https://www.jcsistema.online";

export function siteUrl() {
  const value = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.WHATSAPP_PUBLIC_BASE_URL || DEFAULT_SITE_URL;
  return value.trim().replace(/\/+$/, "");
}

// O domínio com e sem "www" contam como o mesmo site.
export function siteHosts() {
  const host = new URL(siteUrl()).host.toLowerCase();
  const bare = host.replace(/^www\./, "");
  return [...new Set([host, bare, `www.${bare}`])];
}
