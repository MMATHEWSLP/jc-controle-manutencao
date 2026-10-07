import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { users } from "../../../../../db/schema";
import { assertSameOrigin, audit, createSession, sessionCookie } from "../../../../../lib/auth";
import { FieldAuthError, verifyFieldOperator } from "../../../../../lib/field-auth";

// Passo 2 (depois do "Sou eu, continuar"): confere de novo nome + código e abre a sessão de
// campo (30 dias, renovada a cada uso — lib/session-rules.ts). O que essa sessão pode acessar é
// limitado em lib/auth.ts (authorize).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const operator = await verifyFieldOperator(request, Number(body.operatorId), String(body.code ?? "").trim());
    const now = new Date().toISOString();
    const db = await getDb();
    await db.update(users).set({ lastAccessAt: now, updatedAt: now }).where(eq(users.id, operator.id));
    const token = await createSession(operator.id, "FIELD");
    try { await audit(operator.id, operator.id, "LOGIN_CAMPO", undefined, { at: now }); } catch { /* auditoria não impede o acesso */ }
    return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(token) } });
  } catch (error) {
    if (error instanceof FieldAuthError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[auth.field.login]", error);
    return Response.json({ error: "Não foi possível entrar agora. Tente novamente." }, { status: 503 });
  }
}
