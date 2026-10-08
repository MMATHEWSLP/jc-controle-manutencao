import { authorize } from "../../../../../lib/auth";
import { ConvoyError, convoyFilterOptions } from "../../../../../lib/convoy";

// Opções dos filtros do Histórico da aprovação do comboio (motorista, comboio, equipamento).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    return Response.json(await convoyFilterOptions(auth.user!));
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.filters]", error);
    return Response.json({ error: "Não foi possível carregar os filtros." }, { status: 500 });
  }
}
