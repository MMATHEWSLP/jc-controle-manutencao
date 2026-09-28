import { asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, departments } from "../db/schema";
import { catalogKey, departmentName } from "./catalog-rules";
import { StockError } from "./stock";

// Departamentos: lista única do sistema (Movimentação e Solicitação de Pedidos). Quem escolhe só vê
// os ativos; quem tem "departments.manage" cadastra, renomeia e desativa.

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function listDepartments(db: Tx, includeInactive = false) {
  const rows = await db.select({ id: departments.id, name: departments.name, active: departments.active }).from(departments)
    .where(includeInactive ? undefined : eq(departments.active, true)).orderBy(asc(departments.name));
  return rows;
}

// Departamento escolhido num lançamento: precisa existir e estar ativo.
export async function requireDepartment(db: Tx, id: number) {
  const row = (await db.select({ id: departments.id, name: departments.name, active: departments.active }).from(departments).where(eq(departments.id, id)).limit(1))[0];
  if (!row || !row.active) throw new StockError("Departamento não encontrado ou desativado.", 404);
  return row;
}

// Cadastra (ou devolve o já existente com a mesma grafia-chave, reativando se estava desativado).
export async function createDepartment(db: Tx, value: unknown, userId: number) {
  const name = departmentName(typeof value === "string" ? value : "");
  const key = catalogKey(name);
  if (!key) throw new StockError("Informe o nome do departamento.");
  const same = (await db.select().from(departments).where(eq(departments.key, key)).limit(1))[0];
  if (same) {
    if (!same.active) await db.update(departments).set({ active: true, updatedAt: new Date().toISOString() }).where(eq(departments.id, same.id));
    return { department: { id: same.id, name: same.name, active: true }, created: false };
  }
  const [row] = await db.insert(departments).values({ name, key, createdBy: userId }).returning({ id: departments.id, name: departments.name, active: departments.active });
  await db.insert(auditLogs).values({ userId, entityType: "DEPARTMENT", entityId: String(row.id), action: "DEPARTAMENTO CADASTRADO", newValue: JSON.stringify(row) });
  return { department: row, created: true };
}

export async function updateDepartment(db: Tx, id: number, body: Record<string, unknown>, userId: number) {
  const current = (await db.select().from(departments).where(eq(departments.id, id)).limit(1))[0];
  if (!current) throw new StockError("Departamento não encontrado.", 404);
  const changes: Partial<typeof departments.$inferInsert> = {};
  if (typeof body.name === "string") {
    const name = departmentName(body.name);
    const key = catalogKey(name);
    if (!key) throw new StockError("Informe o nome do departamento.");
    const clash = (await db.select({ id: departments.id }).from(departments).where(eq(departments.key, key)).limit(1))[0];
    if (clash && clash.id !== id) throw new StockError("Já existe um departamento com este nome.", 409);
    changes.name = name; changes.key = key;
  }
  if (typeof body.active === "boolean") changes.active = body.active;
  if (!Object.keys(changes).length) return { id: current.id, name: current.name, active: current.active };
  const [row] = await db.update(departments).set({ ...changes, updatedAt: new Date().toISOString() }).where(eq(departments.id, id)).returning({ id: departments.id, name: departments.name, active: departments.active });
  await db.insert(auditLogs).values({ userId, entityType: "DEPARTMENT", entityId: String(id), action: "DEPARTAMENTO ALTERADO", previousValue: JSON.stringify({ name: current.name, active: current.active }), newValue: JSON.stringify(changes) });
  return row;
}
