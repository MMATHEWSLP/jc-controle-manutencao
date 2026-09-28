import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { getDb } from "../db";
import { productBrands, products, suppliers } from "../db/schema";
import { brandName, catalogKey } from "./catalog-rules";
import { StockError } from "./stock";

// Fornecedores e marcas: uma base só para o cadastro de Produtos e para a cotação/recebimento das
// Compras. Cadastrar em qualquer um desses lugares deixa disponível na hora para os outros.

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function listBrands(db: Tx) {
  const [registered, used] = await Promise.all([
    db.select({ name: productBrands.name, key: productBrands.key }).from(productBrands),
    db.selectDistinct({ name: products.brand }).from(products).where(and(isNotNull(products.brand), ne(products.brand, ""))),
  ]);
  const byKey = new Map<string, string>();
  for (const row of registered) byKey.set(row.key, row.name);
  for (const row of used) { const key = catalogKey(row.name!); if (key && !byKey.has(key)) byKey.set(key, row.name!); }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

// Devolve o nome canônico da marca (o já cadastrado com a mesma chave, se existir) e garante que
// ela está na lista única.
export async function ensureBrand(db: Tx, value: string | null | undefined, userId: number | null) {
  const name = brandName(value ?? "");
  const key = catalogKey(name);
  if (!key) return null;
  const existing = (await db.select({ name: productBrands.name }).from(productBrands).where(eq(productBrands.key, key)).limit(1))[0];
  if (existing) return existing.name;
  await db.insert(productBrands).values({ name, key, createdBy: userId }).onConflictDoNothing();
  return (await db.select({ name: productBrands.name }).from(productBrands).where(eq(productBrands.key, key)).limit(1))[0]?.name ?? name;
}

export async function listActiveSuppliers(db: Tx) {
  return db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.active, true)).orderBy(asc(suppliers.name));
}

// Cadastro rápido de fornecedor (só o nome). Se já existir um com a mesma grafia-chave, devolve ele
// (reativando se estava inativo) em vez de criar duplicado.
export async function quickCreateSupplier(db: Tx, value: unknown) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 160) : "";
  const key = catalogKey(name);
  if (!key) throw new StockError("Informe o nome do fornecedor.");
  const all = await db.select({ id: suppliers.id, name: suppliers.name, active: suppliers.active }).from(suppliers);
  const same = all.find((row) => catalogKey(row.name) === key);
  if (same) {
    if (!same.active) await db.update(suppliers).set({ active: true, updatedAt: new Date().toISOString() }).where(eq(suppliers.id, same.id));
    return { supplier: { id: same.id, name: same.name }, created: false };
  }
  const [created] = await db.insert(suppliers).values({ name }).returning({ id: suppliers.id, name: suppliers.name });
  return { supplier: created, created: true };
}
