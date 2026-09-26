// Teste de conexão do app: responde rápido, sem banco e sem cache. O iPhone nem sempre
// avisa corretamente quando fica sem internet (navigator.onLine continua "true" em modo
// avião), então o app confirma a conexão de verdade chamando esta rota.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, at: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
