import { searchFieldOperators } from "../../../../../lib/field-auth";

// Público (tela de login): devolve só id e nome, no máximo 8, a partir de 2 letras.
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json({ operators: await searchFieldOperators(q) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[auth.field.search]", error);
    return Response.json({ error: "Não foi possível buscar agora." }, { status: 503 });
  }
}
