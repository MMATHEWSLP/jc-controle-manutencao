import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { auditLogs, companies, employees } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";

type Context = { params: Promise<{ companyId: string }> };

// Renomear (os cadastros acompanham o novo nome) ou ativar/desativar (desativada some do dropdown,
// mas quem já está nela continua).
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.companies");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const id = Number((await params).companyId);
    const current = (await db.select().from(companies).where(eq(companies.id, id)).limit(1))[0];
    if (!current) return Response.json({ error: "Empresa não encontrada." }, { status: 404 });
    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().toUpperCase() : current.name;
    const active = typeof body.active === "boolean" ? body.active : current.active;
    if (name.length < 2) return Response.json({ error: "Informe o nome da empresa." }, { status: 400 });
    if (name !== current.name && (await db.select({ id: companies.id }).from(companies).where(and(eq(companies.name, name), ne(companies.id, id))).limit(1)).length)
      return Response.json({ error: `A empresa ${name} já está na lista.` }, { status: 409 });
    await db.transaction(async (tx) => {
      await tx.update(companies).set({ name, active, updatedAt: new Date().toISOString() }).where(eq(companies.id, id));
      if (name !== current.name) await tx.update(employees).set({ company: name }).where(eq(employees.company, current.name));
      await tx.insert(auditLogs).values({ userId: auth.user!.id, entityType: "COMPANY", entityId: String(id), action: "EMPRESA ATUALIZADA", previousValue: JSON.stringify(current), newValue: JSON.stringify({ name, active }) });
    });
    return Response.json({ message: name !== current.name ? `Empresa renomeada para ${name}.` : active ? "Empresa ativada." : "Empresa desativada." });
  } catch (error) {
    console.error("[employees.companies.put]", error);
    return Response.json({ error: "Não foi possível atualizar a empresa agora." }, { status: 500 });
  }
}
