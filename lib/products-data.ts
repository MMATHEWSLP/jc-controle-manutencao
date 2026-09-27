import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, equipmentModels, productEquipmentModels, productFrontStock, productPhotos, productReferences, products, serviceFronts } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { joinReferences, normalizeReference, normalizeTag } from "./product-rules";

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Tx;

// `editable` = frente que a pessoa enxerga (pode alterar o estoque). As demais vêm só para consulta:
// quem é de uma frente só vê a quantidade das outras frentes, mas não altera.
export type ProductFrontInfo = { serviceFrontId: number; name: string; active: boolean; quantity: number; editable: boolean };
export type ProductExtras = {
  references: string[];
  equipmentModelIds: number[];
  applicationNames: string[];
  photoIds: number[];
  fronts: ProductFrontInfo[];
};

export class ProductRuleError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

export function productRuleResponse(error: unknown) {
  return error instanceof ProductRuleError ? Response.json({ error: error.message }, { status: error.status }) : null;
}

export async function activeFrontList(db: DbLike) {
  return db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name));
}

// Frentes (ativas) que o usuário enxerga — as únicas cujo estoque ele vê e pode alterar.
export async function visibleFrontList(db: DbLike, user: SessionUser) {
  const fronts = await activeFrontList(db);
  const visible = frentesVisiveis(user);
  return visible === "ALL" ? fronts : fronts.filter((front) => visible.includes(front.id));
}

// Referências, aplicações, fotos e estoque por frente dos produtos da página, em poucas consultas.
// Quantidade de frente que o usuário não enxerga volta marcada como editable=false (só leitura).
export async function loadProductExtras(db: DbLike, ids: number[], user: SessionUser) {
  const map = new Map<number, ProductExtras>();
  for (const id of ids) map.set(id, { references: [], equipmentModelIds: [], applicationNames: [], photoIds: [], fronts: [] });
  if (ids.length === 0) return map;
  const visible = frentesVisiveis(user);
  const [references, models, photos, stocks] = await Promise.all([
    db.select({ productId: productReferences.productId, reference: productReferences.reference }).from(productReferences)
      .where(inArray(productReferences.productId, ids)).orderBy(asc(productReferences.position), asc(productReferences.id)),
    db.select({ productId: productEquipmentModels.productId, id: equipmentModels.id, name: equipmentModels.name }).from(productEquipmentModels)
      .innerJoin(equipmentModels, eq(productEquipmentModels.equipmentModelId, equipmentModels.id))
      .where(inArray(productEquipmentModels.productId, ids)).orderBy(asc(equipmentModels.name)),
    db.select({ productId: productPhotos.productId, id: productPhotos.id }).from(productPhotos)
      .where(inArray(productPhotos.productId, ids)).orderBy(asc(productPhotos.position), asc(productPhotos.id)),
    db.select({ productId: productFrontStock.productId, serviceFrontId: productFrontStock.serviceFrontId, name: serviceFronts.name, active: productFrontStock.active, quantity: productFrontStock.quantity })
      .from(productFrontStock).innerJoin(serviceFronts, eq(productFrontStock.serviceFrontId, serviceFronts.id))
      .where(inArray(productFrontStock.productId, ids)).orderBy(asc(serviceFronts.name)),
  ]);
  for (const row of references) map.get(row.productId)?.references.push(row.reference);
  for (const row of models) {
    const extras = map.get(row.productId);
    extras?.equipmentModelIds.push(row.id);
    extras?.applicationNames.push(row.name);
  }
  for (const row of photos) map.get(row.productId)?.photoIds.push(row.id);
  for (const row of stocks) {
    const canSee = visible === "ALL" || visible.includes(row.serviceFrontId);
    map.get(row.productId)?.fronts.push({ serviceFrontId: row.serviceFrontId, name: row.name, active: row.active, quantity: row.quantity, editable: canSee });
  }
  return map;
}

// Situação do produto nas frentes em exibição: ativo lá? quanto tem somando essas frentes?
export function scopeSummary(fronts: ProductFrontInfo[], displayed: number[] | "ALL") {
  const inScope = fronts.filter((front) => front.active && (displayed === "ALL" || displayed.includes(front.serviceFrontId)));
  return { activeHere: inScope.length > 0, quantityHere: inScope.reduce((sum, front) => sum + front.quantity, 0) };
}

// ---------------------------------------------------------------------------
// Validações globais (valem para o sistema inteiro, não só para a frente).
// ---------------------------------------------------------------------------
export async function assertTagAvailable(db: DbLike, tag: string, exceptId?: number) {
  const normalized = normalizeTag(tag);
  const rows = await db.select({ id: products.id, name: products.name, tag: products.tag }).from(products)
    .where(and(sql`upper(${products.tag})=${normalized}`, exceptId ? ne(products.id, exceptId) : undefined)).limit(1);
  if (rows[0]) throw new ProductRuleError(`A TAG ${normalized} já está em uso pelo produto "${rows[0].name}".`, 409);
}

export async function assertReferencesAvailable(db: DbLike, references: string[], exceptId?: number) {
  if (references.length === 0) return;
  const keys = references.map(normalizeReference);
  const rows = await db.select({ normalized: productReferences.normalized, reference: productReferences.reference, tag: products.tag, name: products.name })
    .from(productReferences).innerJoin(products, eq(productReferences.productId, products.id))
    .where(and(inArray(productReferences.normalized, keys), exceptId ? ne(productReferences.productId, exceptId) : undefined)).limit(1);
  if (rows[0]) {
    const typed = references[keys.indexOf(rows[0].normalized)] ?? rows[0].reference;
    throw new ProductRuleError(`A referência ${typed} já está cadastrada no produto TAG ${rows[0].tag} — ${rows[0].name}.`, 409);
  }
}

export async function assertModelsExist(db: DbLike, ids: number[]) {
  if (ids.length === 0) return;
  const rows = await db.select({ id: equipmentModels.id }).from(equipmentModels).where(inArray(equipmentModels.id, ids));
  if (rows.length !== ids.length) throw new ProductRuleError("Um dos modelos de equipamento selecionados não existe.");
}

export function parseModelIds(body: Record<string, unknown>): number[] | undefined {
  if (Array.isArray(body.equipmentModelIds)) return [...new Set(body.equipmentModelIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (body.equipmentModelId !== undefined) return body.equipmentModelId ? [Number(body.equipmentModelId)].filter((id) => Number.isInteger(id) && id > 0) : [];
  return undefined;
}

export async function replaceReferences(db: DbLike, productId: number, references: string[]) {
  await db.delete(productReferences).where(eq(productReferences.productId, productId));
  if (references.length) await db.insert(productReferences).values(references.map((reference, position) => ({ productId, reference, normalized: normalizeReference(reference), position })));
  await db.update(products).set({ reference: joinReferences(references) }).where(eq(products.id, productId));
}

export async function replaceModels(db: DbLike, productId: number, modelIds: number[]) {
  await db.delete(productEquipmentModels).where(eq(productEquipmentModels.productId, productId));
  if (modelIds.length) await db.insert(productEquipmentModels).values(modelIds.map((equipmentModelId) => ({ productId, equipmentModelId })));
  await db.update(products).set({ equipmentModelId: modelIds[0] ?? null }).where(eq(products.id, productId));
}

// Ativa (ou reativa) o produto numa frente. Nunca mexe na quantidade de uma linha existente;
// linha nova começa zerada.
export async function activateInFront(db: DbLike, productId: number, serviceFrontId: number, userId: number) {
  const now = new Date().toISOString();
  await db.insert(productFrontStock).values({ productId, serviceFrontId, quantity: 0, active: true, activatedAt: now, activatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: [productFrontStock.productId, productFrontStock.serviceFrontId], set: { active: true, activatedAt: now, activatedBy: userId, updatedAt: now } });
}

export async function productAudit(db: DbLike, userId: number, productId: number, action: string, previousValue?: unknown, newValue?: unknown) {
  await db.insert(auditLogs).values({
    userId, entityType: "PRODUCT", entityId: String(productId), action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: newValue === undefined ? null : JSON.stringify(newValue),
  });
}

// Frente em que um produto NOVO nasce ativo: a escolhida no formulário (se a pessoa enxerga), senão
// a única frente em exibição, senão a frente principal, senão a única frente que ela enxerga.
export async function resolveCreationFront(db: DbLike, user: SessionUser, requested: unknown, displayed: number[] | "ALL") {
  const fronts = await visibleFrontList(db, user);
  const ids = fronts.map((front) => front.id);
  const wanted = Number(requested);
  if (Number.isInteger(wanted) && wanted > 0) {
    if (!ids.includes(wanted)) throw new ProductRuleError("Você não tem acesso à frente de serviço escolhida.", 403);
    return wanted;
  }
  if (displayed !== "ALL" && displayed.length === 1 && ids.includes(displayed[0])) return displayed[0];
  if (user.serviceFrontId && ids.includes(user.serviceFrontId)) return user.serviceFrontId;
  if (ids.length === 1) return ids[0];
  throw new ProductRuleError("Escolha em qual frente de serviço o produto será ativado.");
}
