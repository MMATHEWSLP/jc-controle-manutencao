import { authorize } from "../../../../lib/auth";
import { fieldAccessCandidates } from "../../../../lib/field-operators";

// "Da lista de funcionários": quem do cadastro principal (não demitido) ainda não tem acesso de campo.
export async function GET(request: Request) {
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try { return Response.json(await fieldAccessCandidates(auth.user!)); }
  catch (error) { console.error("[field-operators.candidates]", error); return Response.json({ error: "Não foi possível carregar a lista de funcionários." }, { status: 500 }); }
}
