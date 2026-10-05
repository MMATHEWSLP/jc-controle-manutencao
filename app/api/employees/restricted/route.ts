import { getDb } from "../../../../db";
import { authorize } from "../../../../lib/auth";
import { canSeeSensitive, listRestricted } from "../../../../lib/employees";

// Funcionários Restritos (demitidos que não podem ser recontratados), consultados no cadastro.
export async function GET(request: Request) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    // Lista de restrição (com motivo e CPF): só ADMIN (LGPD).
    if (!canSeeSensitive(auth.user!)) return Response.json({ error: "A lista de funcionários restritos é visível só para o ADMIN." }, { status: 403 });
    const db = await getDb();
    return Response.json({ restricted: await listRestricted(db) });
  } catch (error) {
    console.error("[employees.restricted]", error);
    return Response.json({ error: "Não foi possível carregar os funcionários restritos agora." }, { status: 500 });
  }
}
