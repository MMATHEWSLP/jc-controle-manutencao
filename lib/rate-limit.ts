// Limite simples de requisições por chave (ex.: IP) numa janela de tempo, em memória do processo.
// Serve para rotas públicas baratas (busca de nomes no login de campo); não substitui o bloqueio
// por tentativas erradas, que fica no banco (lib/field-auth.ts).
const buckets = new Map<string, { count: number; resetAt: number }>();

export function allowRequest(key: string, limit: number, windowMs: number, now = Date.now()) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 5000) for (const [name, value] of buckets) if (value.resetAt <= now) buckets.delete(name);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
