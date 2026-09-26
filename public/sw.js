/* Service worker do JC Sistema (app instalável).
 *
 * - Arquivos do app (/_next/static, ícones): guardados no celular na primeira visita, para o
 *   app abrir mesmo sem internet.
 * - Páginas e consultas da API (GET que devolvem JSON): sempre busca na internet primeiro; só
 *   quando não há conexão usa a última cópia salva — assim os dados nunca ficam velhos com sinal.
 * - Gravações (POST/PUT/DELETE) nunca passam pelo cache. O Controle Diário tem fila própria
 *   (lib/offline-queue.ts) para enviar depois.
 * - Ao sair do sistema ou entrar com outro usuário, a página pede para apagar os dados salvos
 *   (mensagem CLEAR_USER_DATA), para um funcionário nunca ver dados de outro no mesmo celular.
 */
const VERSION = "v1";
const STATIC_CACHE = `jc-static-${VERSION}`;
const PAGE_CACHE = `jc-pages-${VERSION}`;
const API_CACHE = `jc-api-${VERSION}`;
const PRECACHE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/jc-florestais-logo.png", "/favicon.svg"];
// Exportações (PDF/Excel/CSV) e login/logout nunca são guardados.
const API_SKIP = [/^\/api\/auth\/(login|logout|theme)/, /-pdf(\/|$)/, /-xlsx(\/|$)/, /-csv(\/|$)/, /^\/api\/whatsapp/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, PAGE_CACHE, API_CACHE]);
    for (const key of await caches.keys()) if (key.startsWith("jc-") && !keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CLEAR_USER_DATA") {
    event.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(PAGE_CACHE)]));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(STATIC_CACHE)).put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  try {
    const response = await fetch(request);
    const type = response.headers.get("content-type") || "";
    if (response.ok && (cacheName !== API_CACHE || type.includes("application/json"))) (await caches.open(cacheName)).put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await caches.match(request, { cacheName })) || (fallbackUrl && (await caches.match(fallbackUrl)));
    if (cached) return cached;
    if (cacheName === API_CACHE) {
      return new Response(JSON.stringify({ error: "Sem conexão com a internet. Estes dados ainda não foram carregados neste celular." }), { status: 503, headers: { "Content-Type": "application/json", "X-Offline": "1" } });
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || /\.(png|svg|ico|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, PAGE_CACHE, "/"));
    return;
  }
  if (url.pathname.startsWith("/api/") && !API_SKIP.some((pattern) => pattern.test(url.pathname))) {
    event.respondWith(networkFirst(request, API_CACHE));
  }
});
