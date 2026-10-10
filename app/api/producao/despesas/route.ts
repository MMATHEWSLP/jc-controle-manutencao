import { ProductionError, scopedFrontIds } from "../../../../lib/production";
import { parsePeriod } from "../../../../lib/production-felling";
import { createMaintenance, createMaterial, deleteExpense, listExpenses } from "../../../../lib/production-expenses";
import { noStore, productionRoute, readBody } from "../../../../lib/production-api";

// Despesas e perdas da Produção (com R$): ?setor=DERRUBA&de&ate&projeto.
export async function GET(request: Request) {
  return productionRoute(request, "despesas.get", async ({ db, access, fronts, params }) => {
    if (!access.costs) throw new ProductionError("As despesas ficam com quem vê os custos da Produção.", 403);
    const expenses = await listExpenses(db, scopedFrontIds(fronts, params.get("frentes")), parsePeriod(params), "DERRUBA");
    const total = Math.round(expenses.reduce((sum, row) => sum + (row.value ?? 0), 0) * 100) / 100;
    return Response.json({ expenses, total }, noStore);
  });
}

// { tipo: MATERIAL | MANUTENCAO | PERDA_TOTAL, ... }
export async function POST(request: Request) {
  return productionRoute(request, "despesas.post", async ({ db, user, fronts }) => {
    const body = await readBody(request);
    const message = body.tipo === "MATERIAL" ? await createMaterial(db, user, fronts, body) : await createMaintenance(db, user, fronts, { ...body, kind: body.tipo });
    return Response.json({ message }, { status: 201 });
  }, { write: true });
}

// ?origem=ESTOQUE|OUTROS&id=ID — saída de estoque é estornada; outro gasto é excluído.
export async function DELETE(request: Request) {
  return productionRoute(request, "despesas.delete", async ({ db, user, fronts, params }) =>
    Response.json({ message: await deleteExpense(db, user, fronts, String(params.get("origem") ?? ""), Number(params.get("id"))) }), { write: true });
}
