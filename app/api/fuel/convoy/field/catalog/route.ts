import { authorize } from "../../../../../../lib/auth";
import { ConvoyError, convoyFieldCatalog } from "../../../../../../lib/convoy";

// Cadastro para o celular do motorista do comboio (equipamentos com a última leitura, funcionários,
// motivos de "sem foto"). O app guarda no IndexedDB para registrar sem internet.
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_register");
  if (auth.response) return auth.response;
  try {
    return Response.json(await convoyFieldCatalog(auth.user!), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.field.catalog]", error);
    return Response.json({ error: "Não foi possível baixar o cadastro agora." }, { status: 500 });
  }
}
