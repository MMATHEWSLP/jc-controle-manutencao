import { clientIp, searchFieldOperators } from "../../../../../lib/field-auth";
import { allowRequest } from "../../../../../lib/rate-limit";

// Público (tela de login): devolve só id e nome, no máximo 8, a partir de 2 letras.
export async function GET(request: Request) {
  if (!allowRequest(`field-search:${clientIp(request)}`, 30, 60_000))
    return Response.json({ error: "Muitas buscas seguidas. Aguarde um minuto." }, { status: 429 });
  try {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json({ operators: await searchFieldOperators(q) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[auth.field.search]", error);
    return Response.json({ error: "Não foi possível buscar agora." }, { status: 503 });
  }
}
