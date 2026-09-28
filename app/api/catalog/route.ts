import { getDb } from "../../../db";
import { auditLogs } from "../../../db/schema";
import { assertSameOrigin, authorize, type Permission } from "../../../lib/auth";
import { ensureBrand, listActiveSuppliers, listBrands, quickCreateSupplier } from "../../../lib/catalog";
import { stockErrorResponse } from "../../../lib/stock";

// Base única de fornecedores e marcas usada no cadastro de Produtos e na cotação/recebimento das
// Compras. Cadastrar aqui deixa disponível na hora para todos esses lugares.
const VIEW: Permission[] = ["products.view", "suppliers.view", "purchases.view"];
const CREATE_SUPPLIER: Permission[] = ["suppliers.create", "purchases.request", "purchases.buy", "purchases.manage"];
const CREATE_BRAND: Permission[] = ["products.create", "products.edit", "purchases.request", "purchases.buy", "purchases.manage"];

export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  if (!VIEW.some((permission) => auth.user!.permissions.includes(permission))) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const db = await getDb();
    const [suppliers, brands] = await Promise.all([listActiveSuppliers(db), listBrands(db)]);
    return Response.json({ suppliers, brands });
  } catch (error) {
    console.error("[catalog.get]", error);
    return Response.json({ error: "Não foi possível carregar fornecedores e marcas." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  try {
    const body = await request.json() as Record<string, unknown>;
    const db = await getDb();
    if (body.kind === "SUPPLIER") {
      if (!CREATE_SUPPLIER.some((permission) => user.permissions.includes(permission))) return Response.json({ error: "Você não possui permissão para cadastrar fornecedor." }, { status: 403 });
      const result = await quickCreateSupplier(db, body.name);
      if (result.created) await db.insert(auditLogs).values({ userId: user.id, entityType: "SUPPLIER", entityId: String(result.supplier.id), action: "FORNECEDOR CADASTRADO", newValue: JSON.stringify(result.supplier) });
      return Response.json({ option: result.supplier, created: result.created, message: result.created ? "Fornecedor cadastrado." : `Já existia: ${result.supplier.name}.` }, { status: result.created ? 201 : 200 });
    }
    if (body.kind === "BRAND") {
      if (!CREATE_BRAND.some((permission) => user.permissions.includes(permission))) return Response.json({ error: "Você não possui permissão para cadastrar marca." }, { status: 403 });
      const name = await ensureBrand(db, typeof body.name === "string" ? body.name : "", user.id);
      if (!name) return Response.json({ error: "Informe o nome da marca." }, { status: 400 });
      return Response.json({ option: { name }, message: `Marca ${name} disponível.` }, { status: 201 });
    }
    return Response.json({ error: "Tipo de cadastro inválido." }, { status: 400 });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[catalog.post]", error);
    return Response.json({ error: "Não foi possível cadastrar agora." }, { status: 500 });
  }
}
