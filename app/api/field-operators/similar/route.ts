import { authorize } from "../../../../lib/auth";
import { similarNames } from "../../../../lib/field-operators";

// Nomes parecidos no cadastro principal e nos acessos de campo (cadastro manual e "Vincular").
export async function GET(request: Request) {
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const nome = (params.get("nome") ?? "").trim();
  if (nome.length < 3) return Response.json({ funcionarios: [], acessos: [] });
  try { return Response.json(await similarNames(auth.user!, nome, Number(params.get("ignorar")) || undefined)); }
  catch (error) { console.error("[field-operators.similar]", error); return Response.json({ error: "Não foi possível procurar nomes parecidos." }, { status: 500 }); }
}
