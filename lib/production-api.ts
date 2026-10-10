import { getDb } from "../db";
import { assertSameOrigin, authorize, type SessionUser } from "./auth";
import { productionAccess, productionErrorResponse, productionFronts, type ProductionAccess, type ProductionFront } from "./production";
import { fellingErrorResponse } from "./production-felling";
import { stockErrorResponse } from "./stock";

// Casca comum das rotas /api/producao/*: origem (gravações), sessão, acesso ao módulo, frentes que a
// pessoa vê e o tratamento de erro — cada rota só escreve o que é dela.
type Db = Awaited<ReturnType<typeof getDb>>;
export type ProductionContext = { db: Db; user: SessionUser; access: ProductionAccess; fronts: ProductionFront[]; params: URLSearchParams };

// field: rota do apontador de campo (/api/producao/campo/*) — basta producao.lancar, e ela nunca devolve R$.
export async function productionRoute(request: Request, label: string, run: (context: ProductionContext) => Promise<Response>, options: { write?: boolean; field?: boolean } = {}) {
  if (options.write && !assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  const access = productionAccess(user);
  if (options.field ? !access.launch : !access.view) return Response.json({ error: "Você não tem acesso ao módulo Produção." }, { status: 403 });
  try {
    const db = await getDb();
    return await run({ db, user, access, fronts: await productionFronts(db, user), params: new URL(request.url).searchParams });
  } catch (error) {
    const known = fellingErrorResponse(error) ?? productionErrorResponse(error) ?? stockErrorResponse(error); if (known) return known;
    console.error(`[producao.${label}]`, error);
    return Response.json({ error: "Não foi possível concluir a operação agora. Tente de novo." }, { status: 500 });
  }
}

export const readBody = async (request: Request) => (await request.json().catch(() => ({}))) as Record<string, unknown>;
export const routeId = async (context: { params: Promise<{ id: string }> }) => Number((await context.params).id);
export const noStore = { headers: { "Cache-Control": "no-store" } };
export const pdfResponse = (pdf: Uint8Array<ArrayBuffer>, file: string) => new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${file}.pdf"`, "Cache-Control": "private, no-store" } });
