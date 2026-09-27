import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { productFrontStock, products } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { activateInFront, productAudit, visibleFrontList } from "../../../../../lib/products-data";

type Context = { params: Promise<{ id: string }> };

// Ativa/desativa um produto JÁ CADASTRADO numa frente — é o "dar entrada num produto que aparece
// apagado na minha frente" sem cadastrar de novo. Ativar vincula a mesma ficha (nome, TAG,
// referências, marca, fornecedor, aplicação) a um estoque novo, zerado, daquela frente.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!user.permissions.includes("products.create") && !user.permissions.includes("products.edit"))
    return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Produto inválido." }, { status: 400 });
  try {
    const body = (await request.json()) as { serviceFrontId?: unknown; active?: unknown };
    const serviceFrontId = Number(body.serviceFrontId);
    const active = body.active !== false;
    const db = await getDb();
    const product = (await db.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, id)).limit(1))[0];
    if (!product) return Response.json({ error: "Produto não encontrado." }, { status: 404 });
    const fronts = await visibleFrontList(db, user);
    const front = fronts.find((item) => item.id === serviceFrontId);
    if (!front) return Response.json({ error: "Você não tem acesso a esta frente de serviço." }, { status: 403 });

    if (active) {
      await activateInFront(db, id, serviceFrontId, user.id);
      await productAudit(db, user.id, id, "PRODUTO ATIVADO NA FRENTE", undefined, { serviceFrontId });
      return Response.json({ message: `Produto ativado em ${front.name}.` });
    }
    const current = (await db.select().from(productFrontStock).where(and(eq(productFrontStock.productId, id), eq(productFrontStock.serviceFrontId, serviceFrontId))).limit(1))[0];
    if (!current?.active) return Response.json({ message: `Produto já estava inativo em ${front.name}.` });
    if (current.quantity > 0) return Response.json({ error: `Ainda há ${current.quantity.toLocaleString("pt-BR")} em estoque em ${front.name}. Zere o estoque antes de desativar.` }, { status: 409 });
    await db.update(productFrontStock).set({ active: false, updatedAt: new Date().toISOString() }).where(and(eq(productFrontStock.productId, id), eq(productFrontStock.serviceFrontId, serviceFrontId)));
    await productAudit(db, user.id, id, "PRODUTO DESATIVADO NA FRENTE", { serviceFrontId }, undefined);
    return Response.json({ message: `Produto desativado em ${front.name}.` });
  } catch (error) {
    console.error("[products.fronts.post]", error);
    return Response.json({ error: "Não foi possível alterar o produto nesta frente agora." }, { status: 500 });
  }
}
