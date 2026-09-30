import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { canSeePendencias, loadPendencias } from "../../../lib/pendencias";

// Pendências de dados (só leitura) para ADMIN e GESTOR, nas frentes que a pessoa enxerga.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  if (!canSeePendencias(auth.user!)) return Response.json({ error: "Somente administrador ou gestor vê as pendências de dados." }, { status: 403 });
  try {
    return Response.json({ groups: await loadPendencias(await getD1(), auth.user!), generatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[pendencias]", error);
    return Response.json({ error: "Não foi possível carregar as pendências agora." }, { status: 500 });
  }
}
