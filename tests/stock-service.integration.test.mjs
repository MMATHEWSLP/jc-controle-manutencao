// Teste de integração do serviço único de estoque (lib/stock.ts) num Postgres de teste.
// Só roda com DATABASE_URL apontando para um banco de TESTE já migrado (npm run db:migrate):
//   DATABASE_URL=postgres://... npm run test:stock
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { productFrontStock, products, serviceFronts, users } from "../db/schema.ts";
import { assertStockAvailable, reverseStockMovements, setStockLevel, stockEntry, stockExit, StockError, transferStock } from "../lib/stock.ts";
import { listStockMovements } from "../lib/stock-history.ts";

const enabled = Boolean(process.env.DATABASE_URL);

async function balance(db, productId, frontId) {
  const row = (await db.select().from(productFrontStock).where(eq(productFrontStock.productId, productId))).find((item) => item.serviceFrontId === frontId);
  return row ? Number(row.quantity) : null;
}

test("entrada, saída, transferência, ajuste e estorno mantêm saldo e histórico coerentes", { skip: !enabled }, async () => {
  const db = await getDb();
  const suffix = Date.now().toString(36).toUpperCase();
  const [a] = await db.insert(serviceFronts).values({ name: `TESTE A ${suffix}` }).returning();
  const [b] = await db.insert(serviceFronts).values({ name: `TESTE B ${suffix}` }).returning();
  const [user] = await db.insert(users).values({ email: `stock-${suffix}@teste.local`, name: "Teste estoque", role: "ADMIN" }).returning();
  const [product] = await db.insert(products).values({ tag: `T-${suffix}`, name: "PRODUTO DE TESTE", price: 10 }).returning();

  await db.transaction(async (tx) => {
    await stockEntry(tx, { productId: product.id, serviceFrontId: a.id, quantity: 10, source: "PURCHASE", reason: "Recebimento", userId: user.id, unitPrice: 12.5 });
    await stockExit(tx, { productId: product.id, serviceFrontId: a.id, quantity: 3, source: "STOCK_EXIT", reason: "Saída", userId: user.id });
    await transferStock(tx, { productId: product.id, fromFrontId: a.id, toFrontId: b.id, quantity: 2, source: "MATERIAL_REQUEST", reason: "Envio", userId: user.id });
  });
  assert.equal(await balance(db, product.id, a.id), 5);
  assert.equal(await balance(db, product.id, b.id), 2);

  await setStockLevel(db, { productId: product.id, serviceFrontId: a.id, quantity: 8, userId: user.id });
  assert.equal(await balance(db, product.id, a.id), 8);

  await assert.rejects(() => assertStockAvailable(db, b.id, [{ productId: product.id, quantity: 5, label: "X" }], false), (error) => error instanceof StockError && error.shortages[0].available === 2);
  await assertStockAvailable(db, b.id, [{ productId: product.id, quantity: 5, label: "X" }], true);

  const history = await listStockMovements(db, { productId: product.id, fronts: [a.id, b.id] });
  assert.deepEqual(history.map((row) => row.type).sort(), ["ENTRADA", "ENTRADA", "ENTRADA", "SAIDA", "SAIDA"]);
  assert.equal(history.find((row) => row.source === "ADJUSTMENT").quantity, 3);
  assert.equal(history.find((row) => row.source === "PURCHASE").total, 125);

  // Estorno por documento de origem: só os movimentos daquele documento.
  const [exitMovement] = history.filter((row) => row.source === "STOCK_EXIT");
  assert.ok(exitMovement);
  const reversedNone = await reverseStockMovements(db, { stockExitId: 999999999 }, user.id, "nada");
  assert.equal(reversedNone, 0);
});
