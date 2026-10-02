import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { createThirdPartyEmployee, thirdPartyErrorResponse } from "../../../../../lib/third-parties";
import { parseThirdPartyEmployee } from "../../../../../lib/third-party-rules";

type Context = { params: Promise<{ id: string }> };

// Novo funcionário de um terceiro (aba "Funcionários" da empresa).
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "third_parties.manage");
  if (auth.response) return auth.response;
  const thirdPartyId = Number((await params).id);
  if (!Number.isInteger(thirdPartyId) || thirdPartyId <= 0) return Response.json({ error: "Terceiro inválido." }, { status: 400 });
  try {
    const parsed = parseThirdPartyEmployee(await request.json() as Record<string, unknown>);
    if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
    const id = await createThirdPartyEmployee(await getDb(), auth.user!, thirdPartyId, parsed.value!);
    return Response.json({ id, message: `Funcionário ${parsed.value!.name} cadastrado.` }, { status: 201 });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[third-party-employees.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o funcionário agora." }, { status: 500 });
  }
}
