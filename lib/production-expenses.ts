import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../db";
import { auditLogs, employees, otherExpenses, productionImportBatches, productionProjects, products, stockExits, users } from "../db/schema";
import type { SessionUser } from "./auth";
import { inIds } from "./daily-reports";
import { ProductionError, requireAccess, type ProductionFront } from "./production";
import { fellingRecords, gasolineUnitCosts, localToday, productionProductOptions, type Period } from "./production-felling";
import { cleanName, fuelValue, isIsoDay, parseDecimal, parseSheetDate, roundTo, searchKey } from "./production-rules";
import { cancelStockExit, createStockExit } from "./stock-exits";
import { StockError } from "./stock";

// ---------------------------------------------------------------------------
// PRODUÇÃO → DESPESAS E PERDAS (decisões 2 e D3 do plano):
//  - material de consumo e peça de motosserra do estoque = saída de produto para o funcionário, com o
//    projeto e o setor, pelo preço efetivo da frente (baixa o estoque);
//  - reparo sem peça, perda total sem peça e custo operacional = Outros gastos (other_expenses) com os
//    campos da Produção (entram em RELATÓRIOS → Custos);
//  - a gasolina da derruba entra na lista só como valor (decisão D2), editada no lançamento do dia.
// Tudo o que nasce aqui só se altera/estorna por aqui.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Row = Record<string, unknown>;
const rows = async (db: Db, query: SQL) => ((await db.execute(query)) as unknown as { rows: Row[] }).rows;
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
export type Sector = "DERRUBA" | "ARRASTE" | "SECUNDARIA";
export const KIND_LABELS: Record<string, string> = { MATERIAL: "Material de consumo", MANUTENCAO: "Manutenção de motosserra", PERDA_TOTAL: "Perda total", CUSTO_OPERACIONAL: "Custo operacional", GASOLINA: "Gasolina" };

async function requireProject(db: Db, fronts: ProductionFront[], projectId: number) {
  const project = (await db.select({ id: productionProjects.id, name: productionProjects.name, serviceFrontId: productionProjects.serviceFrontId, active: productionProjects.active })
    .from(productionProjects).where(eq(productionProjects.id, projectId)).limit(1))[0];
  if (!project || !fronts.some((front) => front.id === project.serviceFrontId)) throw new ProductionError("Escolha o projeto.", 400, "projectId");
  return project;
}
async function requireEmployee(db: Db, id: number | null, field = "employeeId") {
  if (!id) throw new ProductionError("Escolha o funcionário.", 400, field);
  const row = (await db.select({ id: employees.id, name: employees.name, status: employees.status }).from(employees).where(eq(employees.id, id)).limit(1))[0];
  if (!row) throw new ProductionError("Funcionário não encontrado.", 404, field);
  if (row.status === "DEMITIDO") throw new ProductionError(`${row.name} está desligado.`, 400, field);
  return row;
}
function readDate(value: unknown) {
  const date = String(value ?? "");
  if (!isIsoDay(date)) throw new ProductionError("Informe a data.", 400, "date");
  if (date > localToday()) throw new ProductionError("A data não pode ser futura.", 400, "date");
  return date;
}
const positive = (value: unknown, field: string, message: string) => { const parsed = parseDecimal(value); if (!Number.isFinite(parsed) || parsed <= 0) throw new ProductionError(message, 400, field); return parsed; };

// Saída de produto da Produção: preço efetivo da frente; sem saldo, a regra do estoque (só ADMIN/GESTOR confirmam negativo).
async function productionStockExit(db: Db, user: SessionUser, input: {
  frontId: number; date: string; employeeId: number; productId: number; quantity: number; notes: string | null; allowNegative: boolean;
  production: { projectId: number; sector: Sector; kind: "MATERIAL" | "MANUTENCAO" | "PERDA_TOTAL"; tool: string | null; importBatchId: number | null };
}) {
  const option = (await productionProductOptions(db, input.frontId)).find((product) => product.id === input.productId);
  if (!option) throw new ProductionError("Escolha um produto marcado para uso na Produção.", 400, "productId");
  return createStockExit(db, user, {
    serviceFrontId: input.frontId, exitDate: input.date, destinationType: "EMPLOYEE", employeeId: input.employeeId, equipmentId: null, departmentId: null,
    thirdPartyId: null, thirdPartyVehicleId: null, thirdPartyEmployeeId: null, receivedBy: null, notes: input.notes,
    items: [{ productId: input.productId, quantity: input.quantity, unitPrice: option.price }], allowNegative: input.allowNegative, production: input.production,
  });
}

// Material de consumo (lima, corrente, óleo 2T...) para o operador responsável.
export async function createMaterial(db: Db, user: SessionUser, fronts: ProductionFront[], body: Record<string, unknown>, sector: Sector = "DERRUBA") {
  requireAccess(user, "launch"); requireAccess(user, "costs", "Despesas da Produção ficam com quem vê os custos da Produção.");
  const project = await requireProject(db, fronts, Number(body.projectId));
  const date = readDate(body.date);
  const employee = await requireEmployee(db, Number(body.employeeId) || null);
  const quantity = positive(body.quantity, "quantity", "Informe a quantidade (maior que zero).");
  const notes = String(body.notes ?? "").trim().slice(0, 300) || null;
  const exit = await productionStockExit(db, user, { frontId: project.serviceFrontId, date, employeeId: employee.id, productId: Number(body.productId), quantity, notes, allowNegative: body.allowNegative === true,
    production: { projectId: project.id, sector, kind: "MATERIAL", tool: null, importBatchId: null } });
  return `Saída ${exit.number} lançada para ${employee.name}.`;
}

// Manutenção de motosserra (peça/reparo) ou perda total. Com peça do estoque = saída de produto; sem peça
// = Outros gastos com o valor informado.
export async function createMaintenance(db: Db, user: SessionUser, fronts: ProductionFront[], body: Record<string, unknown>) {
  requireAccess(user, "launch"); requireAccess(user, "costs", "Despesas da Produção ficam com quem vê os custos da Produção.");
  const kind = body.kind === "PERDA_TOTAL" ? "PERDA_TOTAL" : "MANUTENCAO";
  const project = await requireProject(db, fronts, Number(body.projectId));
  const date = readDate(body.date);
  const employee = await requireEmployee(db, Number(body.employeeId) || null);
  const tool = String(body.tool ?? "").trim().toUpperCase().slice(0, 60) || null;
  const notes = String(body.notes ?? "").trim().slice(0, 300) || null;
  const productId = Number(body.productId) || null;
  if (productId) {
    const quantity = body.quantity === undefined || String(body.quantity).trim() === "" ? 1 : positive(body.quantity, "quantity", "Informe a quantidade (maior que zero).");
    const exit = await productionStockExit(db, user, { frontId: project.serviceFrontId, date, employeeId: employee.id, productId, quantity, notes, allowNegative: body.allowNegative === true,
      production: { projectId: project.id, sector: "DERRUBA", kind, tool, importBatchId: null } });
    return `Saída ${exit.number} lançada (${kind === "PERDA_TOTAL" ? "perda total" : "manutenção"}).`;
  }
  const value = positive(body.value, "value", "Sem peça do estoque, informe o valor (R$).");
  await insertOtherExpense(db, user, { frontId: project.serviceFrontId, projectId: project.id, date, employeeId: employee.id, kind, tool, value, quantity: 1, notes, employeeName: employee.name, importBatchId: null, sector: "DERRUBA" });
  return kind === "PERDA_TOTAL" ? "Perda total lançada." : "Reparo lançado.";
}

async function insertOtherExpense(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], user: SessionUser, input: {
  frontId: number; projectId: number; date: string; employeeId: number | null; employeeName: string | null; kind: "MANUTENCAO" | "PERDA_TOTAL" | "CUSTO_OPERACIONAL";
  tool: string | null; value: number; quantity: number; notes: string | null; importBatchId: number | null; sector: Sector;
}) {
  const label = input.kind === "PERDA_TOTAL" ? "Perda total de motosserra" : input.kind === "MANUTENCAO" ? "Reparo de motosserra" : "Custo operacional";
  const description = [label, input.tool, input.employeeName, input.notes].filter(Boolean).join(" — ").slice(0, 300);
  const amount = roundTo(input.value, 2);
  const [row] = await db.insert(otherExpenses).values({
    serviceFrontId: input.frontId, equipmentId: null, expenseDate: input.date, category: input.kind === "MANUTENCAO" ? "SERVICO" : "OUTROS", amount, description,
    productionProjectId: input.projectId, productionSector: input.sector, productionKind: input.kind, employeeId: input.employeeId, productionTool: input.tool,
    quantity: input.quantity, unitValue: roundTo(amount / (input.quantity || 1), 2), productionImportBatchId: input.importBatchId, createdBy: user.id, updatedBy: user.id,
  }).returning({ id: otherExpenses.id });
  await db.insert(auditLogs).values({ userId: user.id, entityType: "OTHER_EXPENSE", entityId: String(row.id), action: "DESPESA DA PRODUÇÃO LANÇADA", newValue: JSON.stringify(input) });
  return row.id;
}

// ---------------------------------------------------------------------------
// Lista de despesas do setor: saídas de estoque, outros gastos e (derruba) a gasolina valorada.
// ---------------------------------------------------------------------------
export type ExpenseItem = {
  source: "ESTOQUE" | "OUTROS" | "GASOLINA"; id: number; date: string; projectId: number | null; projectName: string | null; employeeName: string | null; equipment: string | null;
  kind: string; item: string; tool: string | null; quantity: number; value: number | null; origin: "ESTOQUE" | "MANUAL" | "IMPORTACAO" | "PRODUCAO";
};
export async function listExpenses(db: Db, frontIds: number[], period: Period, sector: Sector) {
  if (frontIds.length === 0) return [];
  const project = (column: SQL) => (period.projectId ? sql`AND ${column} = ${period.projectId}` : sql``);
  const stock = await rows(db, sql`SELECT se.id, se.exit_date AS day, se.production_project_id AS project_id, pp.name AS project_name, se.employee_id, e.name AS employee_name, se.equipment_id, eq.prefix,
      se.production_kind AS kind, se.production_tool AS tool, se.production_import_batch_id AS batch_id, p.tag, p.name AS product_name, i.quantity, coalesce(i.unit_price, p.price, 0)::float8 AS unit_price
    FROM stock_exits se JOIN stock_exit_items i ON i.exit_id = se.id JOIN products p ON p.id = i.product_id
    LEFT JOIN production_projects pp ON pp.id = se.production_project_id LEFT JOIN employees e ON e.id = se.employee_id LEFT JOIN equipment eq ON eq.id = se.equipment_id
    WHERE se.cancelled_at IS NULL AND se.production_sector = ${sector} AND ${inIds(sql`se.service_front_id`, frontIds)} AND se.exit_date BETWEEN ${period.from} AND ${period.to} ${project(sql`se.production_project_id`)}`);
  const others = await rows(db, sql`SELECT o.id, o.expense_date AS day, o.production_project_id AS project_id, pp.name AS project_name, o.employee_id, e.name AS employee_name, o.equipment_id, eq.prefix,
      o.production_kind AS kind, o.production_tool AS tool, o.production_import_batch_id AS batch_id, o.description, coalesce(o.quantity, 1) AS quantity, o.amount
    FROM other_expenses o LEFT JOIN production_projects pp ON pp.id = o.production_project_id LEFT JOIN employees e ON e.id = o.employee_id LEFT JOIN equipment eq ON eq.id = o.equipment_id
    WHERE o.deleted_at IS NULL AND o.production_sector = ${sector} AND ${inIds(sql`o.service_front_id`, frontIds)} AND o.expense_date BETWEEN ${period.from} AND ${period.to} ${project(sql`o.production_project_id`)}`);
  const list: ExpenseItem[] = [
    ...stock.map((row): ExpenseItem => ({ source: "ESTOQUE", id: num(row.id), date: String(row.day), projectId: row.project_id === null ? null : num(row.project_id), projectName: text(row.project_name),
      employeeName: text(row.employee_name), equipment: text(row.prefix), kind: String(row.kind ?? "MATERIAL"), item: `${row.tag} ${row.product_name}`, tool: text(row.tool),
      quantity: num(row.quantity), value: roundTo(num(row.quantity) * num(row.unit_price), 2), origin: row.batch_id === null ? "ESTOQUE" : "IMPORTACAO" })),
    ...others.map((row): ExpenseItem => ({ source: "OUTROS", id: num(row.id), date: String(row.day), projectId: row.project_id === null ? null : num(row.project_id), projectName: text(row.project_name),
      employeeName: text(row.employee_name), equipment: text(row.prefix), kind: String(row.kind ?? "CUSTO_OPERACIONAL"), item: String(row.description), tool: text(row.tool),
      quantity: num(row.quantity), value: roundTo(num(row.amount), 2), origin: row.batch_id === null ? "MANUAL" : "IMPORTACAO" })),
  ];
  if (sector === "DERRUBA") {
    const felling = (await fellingRecords(db, frontIds, period)).filter((row) => row.gasolineLiters > 0);
    const costs = await gasolineUnitCosts(db, felling.map((row) => ({ frontId: row.frontId, date: row.date })));
    for (const row of felling) list.push({ source: "GASOLINA", id: row.id, date: row.date, projectId: row.projectId, projectName: row.projectName, employeeName: row.operatorName, equipment: null,
      kind: "GASOLINA", item: "Gasolina (L) — valor do estoque", tool: null, quantity: row.gasolineLiters, value: fuelValue(row.gasolineLiters, costs.get(`${row.frontId}:${row.date}`) ?? null), origin: "PRODUCAO" });
  }
  return list.map((row) => ({ ...row, kindLabel: KIND_LABELS[row.kind] ?? row.kind }))
    .sort((a, b) => b.date.localeCompare(a.date) || (a.projectName ?? "").localeCompare(b.projectName ?? "", "pt-BR") || a.id - b.id);
}

// Excluir (permissão de gerenciar, como os lançamentos): saída de estoque = estorno (o saldo volta);
// outro gasto = exclusão lógica. A gasolina se corrige no lançamento do dia.
export async function deleteExpense(db: Db, user: SessionUser, fronts: ProductionFront[], source: string, id: number) {
  requireAccess(user, "manage", "Excluir despesas exige a permissão de gerenciar a Produção."); requireAccess(user, "costs");
  const frontIds = fronts.map((front) => front.id);
  if (source === "ESTOQUE") {
    const exit = (await db.select({ id: stockExits.id, serviceFrontId: stockExits.serviceFrontId, productionProjectId: stockExits.productionProjectId }).from(stockExits).where(eq(stockExits.id, id)).limit(1))[0];
    if (!exit?.productionProjectId || !frontIds.includes(exit.serviceFrontId)) throw new ProductionError("Despesa não encontrada.", 404);
    await cancelStockExit(db, user, id, "Excluída pela Produção", { fromProduction: true });
    return "Saída estornada: o produto voltou ao estoque.";
  }
  if (source === "OUTROS") {
    const row = (await db.select({ id: otherExpenses.id, serviceFrontId: otherExpenses.serviceFrontId, productionProjectId: otherExpenses.productionProjectId }).from(otherExpenses)
      .where(and(eq(otherExpenses.id, id), isNull(otherExpenses.deletedAt))).limit(1))[0];
    if (!row?.productionProjectId || !frontIds.includes(row.serviceFrontId)) throw new ProductionError("Despesa não encontrada.", 404);
    const at = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(otherExpenses).set({ deletedAt: at, deletedBy: user.id, updatedAt: at }).where(eq(otherExpenses.id, id));
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "OTHER_EXPENSE", entityId: String(id), action: "DESPESA DA PRODUÇÃO EXCLUÍDA" });
    });
    return "Despesa excluída.";
  }
  throw new ProductionError("A gasolina se corrige no lançamento do dia (aba Lançamento).", 400);
}

// ---------------------------------------------------------------------------
// Importação por Excel (só ADMIN): Data, Projeto, Funcionário, Tipo, Produto/TAG, Quantidade, Valor,
// Observação. Prévia sem gravar → confirmação → lote com Desfazer. Linha igual a um registro que já existe
// é ignorada.
// ---------------------------------------------------------------------------
export const IMPORT_COLUMNS = ["data", "projeto", "funcionario", "tipo", "produto", "quantidade", "valor", "observacao"] as const;
export type ImportColumn = typeof IMPORT_COLUMNS[number];
export type ImportRow = { rowNumber: number; values: Partial<Record<ImportColumn, string>> };
type ImportKind = "MATERIAL" | "MANUTENCAO" | "PERDA_TOTAL" | "CUSTO_OPERACIONAL";
export type ImportPreview = {
  rowNumber: number; values: Partial<Record<ImportColumn, string>>; status: "OK" | "ERRO" | "IGUAL"; messages: string[];
  resolved: null | { date: string; projectId: number; projectName: string; frontId: number; employeeId: number | null; employeeName: string | null; kind: ImportKind; productId: number | null; productLabel: string | null; quantity: number; value: number | null };
};

export function importKind(value: string | undefined): ImportKind | null {
  const key = searchKey(value ?? "").replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!key) return null;
  if (key.startsWith("MATERIAL") || key.startsWith("CONSUMO")) return "MATERIAL";
  if (key.startsWith("PERDA")) return "PERDA_TOTAL";
  if (key.startsWith("MANUT") || key.startsWith("REPARO") || key.startsWith("PECA")) return "MANUTENCAO";
  if (key.startsWith("CUSTO") || key.startsWith("OPERACIONAL")) return "CUSTO_OPERACIONAL";
  return null;
}

export async function analyzeImport(db: Db, user: SessionUser, fronts: ProductionFront[], input: ImportRow[]): Promise<ImportPreview[]> {
  if (user.profile !== "ADMIN") throw new ProductionError("Só o administrador importa despesas por planilha.", 403);
  if (input.length === 0) throw new ProductionError("A planilha não tem linhas para importar.");
  if (input.length > 1000) throw new ProductionError("Importe no máximo 1.000 linhas por arquivo.");
  const frontIds = fronts.map((front) => front.id);
  const projects = frontIds.length ? await db.select({ id: productionProjects.id, name: productionProjects.name, frontId: productionProjects.serviceFrontId }).from(productionProjects).where(inArray(productionProjects.serviceFrontId, frontIds)) : [];
  const people = await db.select({ id: employees.id, name: employees.name, status: employees.status }).from(employees);
  const tags = [...new Set(input.map((row) => String(row.values.produto ?? "").trim().split(/\s+/)[0]).filter(Boolean))];
  const catalog = tags.length ? await db.select({ id: products.id, tag: products.tag, name: products.name, productionUse: products.productionUse, active: products.active }).from(products).where(inArray(products.tag, tags)) : [];
  const projectsByKey = new Map<string, typeof projects>();
  for (const project of projects) projectsByKey.set(searchKey(project.name), [...(projectsByKey.get(searchKey(project.name)) ?? []), project]);
  const peopleByKey = new Map<string, typeof people>();
  for (const person of people) peopleByKey.set(searchKey(person.name), [...(peopleByKey.get(searchKey(person.name)) ?? []), person]);
  const today = localToday();
  const previews: ImportPreview[] = input.map((row) => {
    const messages: string[] = [];
    const v = row.values;
    const date = parseSheetDate(v.data);
    if (!date) messages.push("Data inválida (use dd/mm/aaaa).");
    else if (date > today) messages.push("Data futura.");
    const projectMatches = projectsByKey.get(searchKey(cleanName(v.projeto))) ?? [];
    if (!String(v.projeto ?? "").trim()) messages.push("Informe o projeto.");
    else if (projectMatches.length === 0) messages.push(`Projeto "${v.projeto}" não encontrado nas suas frentes.`);
    else if (projectMatches.length > 1) messages.push(`Há mais de um projeto "${v.projeto}" (frentes diferentes).`);
    const kind = importKind(v.tipo);
    if (!kind) messages.push("Tipo inválido (Material, Manutenção, Perda total ou Custo operacional).");
    const personName = String(v.funcionario ?? "").trim();
    const personMatches = personName ? peopleByKey.get(searchKey(personName.replace(/\s+/g, " "))) ?? [] : [];
    if (personName && personMatches.length === 0) messages.push(`Funcionário "${personName}" não encontrado.`);
    else if (personMatches.length > 1) messages.push(`Há mais de um funcionário "${personName}".`);
    if (!personName && kind && kind !== "CUSTO_OPERACIONAL") messages.push("Informe o funcionário.");
    const tag = String(v.produto ?? "").trim().split(/\s+/)[0] ?? "";
    const product = tag ? catalog.find((item) => item.tag === tag) ?? null : null;
    if (tag && !product) messages.push(`Produto com TAG ${tag} não encontrado.`);
    else if (product && !product.productionUse) messages.push(`${product.name} não está marcado para uso na Produção.`);
    if (kind === "MATERIAL" && !tag) messages.push("Material precisa do Produto/TAG.");
    if (kind === "CUSTO_OPERACIONAL" && tag) messages.push("Custo operacional não leva produto.");
    const quantityRaw = String(v.quantidade ?? "").trim();
    const quantity = quantityRaw ? parseDecimal(quantityRaw) : 1;
    if (!Number.isFinite(quantity) || quantity <= 0) messages.push("Quantidade inválida.");
    const valueRaw = String(v.valor ?? "").trim();
    const value = valueRaw ? parseDecimal(valueRaw) : null;
    if (!tag && kind && kind !== "MATERIAL" && (value === null || !Number.isFinite(value) || value <= 0)) messages.push("Sem produto, informe o valor (R$).");
    const project = projectMatches.length === 1 ? projectMatches[0] : null;
    const person = personMatches.length === 1 ? personMatches[0] : null;
    if (messages.length || !date || !project || !kind) return { rowNumber: row.rowNumber, values: v, status: "ERRO" as const, messages, resolved: null };
    return { rowNumber: row.rowNumber, values: v, status: "OK" as const, messages, resolved: {
      date, projectId: project.id, projectName: project.name, frontId: project.frontId, employeeId: person?.id ?? null, employeeName: person?.name ?? null, kind,
      productId: product?.id ?? null, productLabel: product ? `${product.tag} ${product.name}` : null, quantity, value: product ? null : value,
    } };
  });
  // Iguais a registros que já existem (mesmo projeto, dia, funcionário, tipo e produto/quantidade ou valor).
  const ok = previews.filter((row) => row.resolved);
  if (ok.length) {
    const projectIds = [...new Set(ok.map((row) => row.resolved!.projectId))];
    const existingStock = await rows(db, sql`SELECT se.production_project_id AS project_id, se.exit_date AS day, se.employee_id, se.production_kind AS kind, i.product_id, i.quantity
      FROM stock_exits se JOIN stock_exit_items i ON i.exit_id = se.id WHERE se.cancelled_at IS NULL AND se.production_sector = 'DERRUBA' AND ${inIds(sql`se.production_project_id`, projectIds)}`);
    const existingOthers = await rows(db, sql`SELECT o.production_project_id AS project_id, o.expense_date AS day, o.employee_id, o.production_kind AS kind, o.amount
      FROM other_expenses o WHERE o.deleted_at IS NULL AND o.production_sector = 'DERRUBA' AND ${inIds(sql`o.production_project_id`, projectIds)}`);
    const keys = new Set([
      ...existingStock.map((row) => `E|${row.project_id}|${row.day}|${row.employee_id ?? ""}|${row.kind}|${row.product_id}|${num(row.quantity)}`),
      ...existingOthers.map((row) => `O|${row.project_id}|${row.day}|${row.employee_id ?? ""}|${row.kind}|${roundTo(num(row.amount), 2)}`),
    ]);
    const seen = new Set<string>();
    for (const row of ok) {
      const r = row.resolved!;
      const key = r.productId ? `E|${r.projectId}|${r.date}|${r.employeeId ?? ""}|${r.kind}|${r.productId}|${r.quantity}` : `O|${r.projectId}|${r.date}|${r.employeeId ?? ""}|${r.kind}|${roundTo(r.value ?? 0, 2)}`;
      if (keys.has(key)) { row.status = "IGUAL"; row.messages.push("Igual a um registro que já existe: será ignorada."); }
      else if (seen.has(key)) { row.status = "IGUAL"; row.messages.push("Repetida na planilha: será ignorada."); }
      seen.add(key);
    }
  }
  return previews;
}

export async function confirmImport(db: Db, user: SessionUser, fronts: ProductionFront[], fileName: string, input: ImportRow[], allowNegative: boolean) {
  const previews = await analyzeImport(db, user, fronts, input);
  const ready = previews.filter((row) => row.status === "OK");
  if (ready.length === 0) throw new ProductionError("Nenhuma linha pronta para importar.");
  const [batch] = await db.insert(productionImportBatches).values({ kind: "DESPESAS_DERRUBA", fileName: fileName.slice(0, 200) || "planilha.xlsx", rowCount: 0, createdBy: user.id }).returning({ id: productionImportBatches.id });
  const failed: Array<{ rowNumber: number; error: string }> = [];
  let imported = 0;
  let total = 0;
  for (const row of ready) {
    const r = row.resolved!;
    try {
      const notes = String(row.values.observacao ?? "").trim().slice(0, 300) || null;
      // A prévia garante: produto ⇒ funcionário e tipo ≠ custo operacional; sem produto ⇒ valor e tipo ≠ material.
      if (r.productId && r.employeeId && r.kind !== "CUSTO_OPERACIONAL") {
        await productionStockExit(db, user, { frontId: r.frontId, date: r.date, employeeId: r.employeeId, productId: r.productId, quantity: r.quantity, notes, allowNegative,
          production: { projectId: r.projectId, sector: "DERRUBA", kind: r.kind, tool: null, importBatchId: batch.id } });
      } else if (!r.productId && r.value !== null && r.kind !== "MATERIAL") {
        await insertOtherExpense(db, user, { frontId: r.frontId, projectId: r.projectId, date: r.date, employeeId: r.employeeId, employeeName: r.employeeName, kind: r.kind,
          tool: null, value: r.value, quantity: r.quantity, notes, importBatchId: batch.id, sector: "DERRUBA" });
        total += r.value;
      } else throw new ProductionError("Linha incompleta.");
      imported += 1;
    } catch (error) {
      if (error instanceof StockError || error instanceof ProductionError) failed.push({ rowNumber: row.rowNumber, error: error.message });
      else throw error;
    }
  }
  const summary = { imported, failed, ignored: previews.filter((row) => row.status === "IGUAL").length, errors: previews.filter((row) => row.status === "ERRO").length, otherExpensesTotal: roundTo(total, 2) };
  await db.update(productionImportBatches).set({ rowCount: imported, summary: JSON.stringify(summary), updatedAt: new Date().toISOString() }).where(eq(productionImportBatches.id, batch.id));
  await db.insert(auditLogs).values({ userId: user.id, entityType: "PRODUCTION_IMPORT", entityId: String(batch.id), action: "IMPORTAÇÃO DE DESPESAS DA DERRUBA", newValue: JSON.stringify({ fileName, ...summary }) });
  return { batchId: batch.id, ...summary };
}

export async function listImportBatches(db: Db) {
  return (await db.select({ id: productionImportBatches.id, fileName: productionImportBatches.fileName, rowCount: productionImportBatches.rowCount, status: productionImportBatches.status,
    summary: productionImportBatches.summary, createdAt: productionImportBatches.createdAt, revertedAt: productionImportBatches.revertedAt, userName: users.name })
    .from(productionImportBatches).leftJoin(users, eq(users.id, productionImportBatches.createdBy)).orderBy(sql`${productionImportBatches.id} DESC`).limit(30))
    .map((row) => ({ ...row, summary: row.summary ? JSON.parse(row.summary) as Record<string, unknown> : null }));
}

// Desfazer: estorna as saídas de estoque do lote e exclui os outros gastos.
export async function revertImport(db: Db, user: SessionUser, batchId: number) {
  if (user.profile !== "ADMIN") throw new ProductionError("Só o administrador desfaz uma importação.", 403);
  const batch = (await db.select().from(productionImportBatches).where(eq(productionImportBatches.id, batchId)).limit(1))[0];
  if (!batch) throw new ProductionError("Lote não encontrado.", 404);
  if (batch.status === "REVERTED") throw new ProductionError("Este lote já foi desfeito.", 409);
  const exits = await db.select({ id: stockExits.id }).from(stockExits).where(and(eq(stockExits.productionImportBatchId, batchId), isNull(stockExits.cancelledAt)));
  for (const exit of exits) await cancelStockExit(db, user, exit.id, `Desfeita a importação #${batchId}`, { fromProduction: true });
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(otherExpenses).set({ deletedAt: at, deletedBy: user.id, updatedAt: at }).where(and(eq(otherExpenses.productionImportBatchId, batchId), isNull(otherExpenses.deletedAt)));
    await tx.update(productionImportBatches).set({ status: "REVERTED", revertedAt: at, revertedBy: user.id, updatedAt: at }).where(eq(productionImportBatches.id, batchId));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "PRODUCTION_IMPORT", entityId: String(batchId), action: "IMPORTAÇÃO DESFEITA" });
  });
  return { exits: exits.length };
}
