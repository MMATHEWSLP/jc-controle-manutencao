import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { equipment, productFrontStock, productReferences, products, serviceFronts } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { Permission, SessionUser } from "./auth";
import { buildProductWhere } from "./products-filters";
import { visibleFrontList } from "./products-data";
import { fuelLocalDay } from "./fuel";

// Apoio comum às telas que lançam estoque (Movimentação, Ordem de Serviço, Compras): frentes da
// pessoa, equipamentos dessas frentes e busca de produto com o saldo na frente escolhida.

type Db = Awaited<ReturnType<typeof getDb>>;

export const hasAny = (user: SessionUser, permissions: Permission[]) => permissions.some((permission) => user.permissions.includes(permission));

// Dia local (mesmo fuso usado no Combustível e em Funcionários).
export const localToday = () => fuelLocalDay();

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDay = (value: unknown): value is string => typeof value === "string" && ISO_DAY.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());

// Frente padrão do lançamento: a única que a pessoa enxerga, ou a principal dela.
export function defaultFrontId(user: SessionUser, fronts: Array<{ id: number }>) {
  if (fronts.length === 1) return fronts[0].id;
  return user.serviceFrontId && fronts.some((front) => front.id === user.serviceFrontId) ? user.serviceFrontId : null;
}

export async function equipmentOptions(db: Db, user: SessionUser) {
  const visible = frentesVisiveis(user);
  if (visible !== "ALL" && visible.length === 0) return [];
  const rows = await db.select({
    id: equipment.id, prefix: equipment.prefix, type: equipment.type, brand: equipment.brand, model: equipment.model,
    serviceFrontId: equipment.serviceFrontId, front: serviceFronts.name, controlType: equipment.controlType,
    currentHours: equipment.currentHours, currentKm: equipment.currentKm,
  }).from(equipment).leftJoin(serviceFronts, eq(equipment.serviceFrontId, serviceFronts.id))
    .where(visible === "ALL" ? undefined : inArray(equipment.serviceFrontId, visible))
    .orderBy(asc(equipment.sortKey));
  return rows.map((row) => ({
    ...row, description: [row.brand, row.model].filter(Boolean).join(" ") || row.type,
    // Unidade e leitura atual usadas na O.S. (equipamento que controla os dois usa o horímetro).
    meterUnit: row.controlType === "KM" ? "KM" as const : "HOURS" as const,
    currentReading: row.controlType === "KM" ? Number(row.currentKm) : Number(row.currentHours),
  }));
}

export async function stockOptions(db: Db, user: SessionUser) {
  const fronts = await visibleFrontList(db, user);
  return { fronts, defaultFrontId: defaultFrontId(user, fronts), equipment: await equipmentOptions(db, user) };
}

// Busca de produto (TAG, nome ou referência — a mesma da tela Produtos) com saldo e preço.
export async function searchStockProducts(db: Db, url: URL, frontId: number | null) {
  const rows = await db.select({ id: products.id, tag: products.tag, name: products.name, reference: products.reference, price: products.price, brand: products.brand, supplierId: products.supplierId })
    .from(products).where(buildProductWhere(url, "ALL")).orderBy(asc(products.name)).limit(20);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [references, stock] = await Promise.all([
    db.select({ productId: productReferences.productId, reference: productReferences.reference }).from(productReferences).where(inArray(productReferences.productId, ids)),
    frontId ? db.select({ productId: productFrontStock.productId, quantity: productFrontStock.quantity }).from(productFrontStock)
      .where(and(inArray(productFrontStock.productId, ids), eq(productFrontStock.serviceFrontId, frontId))) : Promise.resolve([]),
  ]);
  return rows.map((row) => ({
    ...row, references: references.filter((item) => item.productId === row.id).map((item) => item.reference),
    balance: frontId ? Number(stock.find((item) => item.productId === row.id)?.quantity ?? 0) : null,
  }));
}

export async function productsById(db: Db, ids: number[]) {
  if (ids.length === 0) return new Map<number, { id: number; tag: string; name: string; price: number; active: boolean }>();
  const rows = await db.select({ id: products.id, tag: products.tag, name: products.name, price: products.price, active: products.active }).from(products).where(inArray(products.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row]));
}

