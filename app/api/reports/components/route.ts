import { getDb } from "../../../../db";
import { authorize } from "../../../../lib/auth";
import { COMPONENT_KIND_LABELS, COMPONENT_STATUS_LABELS, type ComponentKind, type ComponentStatus } from "../../../../lib/component-rules";
import { listComponents } from "../../../../lib/components";
import { exportTable } from "../../../../lib/report-export";
import { canSeeReport } from "../../../../lib/reports-catalog";

// RELATÓRIOS → Manutenção → Pneus e baterias: custo, uso e vida útil de cada um, com os alertas
// (valores só para quem vê custos, como na tela Pneus e Baterias). ?tipo=TIRE|BATTERY&situacao=…&formato=xlsx|pdf.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canSeeReport(user, "pneus-baterias")) return Response.json({ error: "Você não tem acesso aos relatórios de manutenção." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const kind = params.get("tipo") === "TIRE" || params.get("tipo") === "BATTERY" ? params.get("tipo") as ComponentKind : null;
    const status = ["STOCK", "MOUNTED", "DISCARDED"].includes(params.get("situacao") ?? "") ? params.get("situacao") as ComponentStatus : null;
    const data = await listComponents(await getDb(), user, { kind, status, equipmentId: Number(params.get("equipamento")) || null, q: params.get("q") });
    const onlyAlerts = params.get("alertas") === "1";
    const items = onlyAlerts ? data.items.filter((item) => item.alert) : data.items;
    const totals = { count: items.length, mounted: items.filter((item) => item.status === "MOUNTED").length, alerts: items.filter((item) => item.alert).length, cost: data.canSeeCosts ? Math.round(items.reduce((sum, item) => sum + (item.totalCost ?? 0), 0) * 100) / 100 : null };
    const format = params.get("formato");
    if (!format) return Response.json({ items, totals, canSeeCosts: data.canSeeCosts }, { headers: { "Cache-Control": "no-store" } });
    type Item = (typeof items)[number];
    const filters = [kind ? COMPONENT_KIND_LABELS[kind] : "Pneus e baterias", status ? COMPONENT_STATUS_LABELS[status] : "Todas as situações", onlyAlerts ? "Só com alerta" : ""].filter(Boolean);
    return exportTable<Item>(format, {
      title: "Pneus e baterias", section: "RELATÓRIOS · MANUTENÇÃO", filters, generatedBy: user.name, file: "pneus-e-baterias",
      columns: [
        { header: "Tipo", value: (row) => COMPONENT_KIND_LABELS[row.kind], width: 0.8 }, { header: "Código", value: (row) => row.code, width: 1 },
        { header: "Marca / modelo", value: (row) => [row.brand, row.model].filter(Boolean).join(" "), width: 1.6 }, { header: "Medida", value: (row) => row.size ?? "", width: 1 },
        { header: "Situação", value: (row) => COMPONENT_STATUS_LABELS[row.status], width: 1 }, { header: "Equipamento", value: (row) => row.prefix ?? "", width: 1 },
        { header: "Uso", value: (row) => (row.usage === null ? "" : `${row.usage.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} ${row.unit === "KM" ? "km" : row.unit === "HOURS" ? "h" : "meses"}`), width: 1 },
        { header: "Vida usada (%)", value: (row) => row.lifePercent, width: 0.9, decimals: 0 },
        ...(data.canSeeCosts ? [{ header: "Custo total (R$)", value: (row: Item) => row.totalCost, width: 1.1, money: true }, { header: "Custo por km/h (R$)", value: (row: Item) => row.costPerUnit, width: 1.1, money: true }] : []),
        { header: "Alerta", value: (row) => row.alert?.text ?? "", width: 2 },
      ],
      rows: items,
      total: ["TOTAL", `${totals.count}`, `${totals.mounted} montados`, "", "", "", "", "", ...(data.canSeeCosts ? [totals.cost, ""] : []), `${totals.alerts} com alerta`],
      footer: "Custo total = compra + eventos (recapagem, conserto...). Vida usada = uso ÷ vida esperada (bateria: meses).",
    });
  } catch (error) {
    console.error("[reports.components]", error);
    return Response.json({ error: "Não foi possível montar o relatório agora." }, { status: 500 });
  }
}
