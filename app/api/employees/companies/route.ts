import { getDb } from "../../../../db";
import { companies } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { listCompanies } from "../../../../lib/employees";

export async function GET(request: Request) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    return Response.json({ companies: await listCompanies(db, { includeInactive: auth.user!.permissions.includes("employees.companies") }) });
  } catch (error) {
    console.error("[employees.companies.get]", error);
    return Response.json({ error: "Não foi possível carregar as empresas agora." }, { status: 500 });
  }
}

// Nova empresa na lista do cadastro (ADMIN por padrão — permissão employees.companies).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.companies");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const name = String(body.name ?? "").replace(/\s+/g, " ").trim().toUpperCase();
    if (name.length < 2) return Response.json({ error: "Informe o nome da empresa." }, { status: 400 });
    const db = await getDb();
    const [row] = await db.insert(companies).values({ name }).onConflictDoNothing().returning({ id: companies.id });
    if (!row) return Response.json({ error: `A empresa ${name} já está na lista.` }, { status: 409 });
    return Response.json({ id: row.id, message: `Empresa ${name} adicionada.` }, { status: 201 });
  } catch (error) {
    console.error("[employees.companies.post]", error);
    return Response.json({ error: "Não foi possível adicionar a empresa agora." }, { status: 500 });
  }
}
