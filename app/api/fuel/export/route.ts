import ExcelJS from "exceljs";
import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { activeFuelTypes, fuelBalances, fuelHistory, fuelScopeFronts, fuelVisibleFronts, parseFuelFilters } from "../../../../lib/fuel";
import { FUEL_MOVEMENT_LABELS } from "../../../../lib/fuel-rules";
import { createFuelHistoryPdf, formatPdfDate } from "../../../../lib/pdf";

// Exporta exatamente o Histórico exibido (mesma query string): ?formato=pdf | ?formato=xlsx.
const EXPORT_LIMIT = 5000;
const liters = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const brDay = (value: string) => value.split("-").reverse().join("/");

export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const params = new URL(request.url).searchParams;
    const format = params.get("formato") === "xlsx" ? "xlsx" : "pdf";
    const filters = parseFuelFilters(params);
    const db = await getDb();
    const [fronts, types] = await Promise.all([fuelVisibleFronts(db, user), activeFuelTypes(db)]);
    const scope = fuelScopeFronts(fronts.map((front) => front.id), frentesEmExibicao(user, request), filters.frontId);
    const [{ rows, total }, balances] = await Promise.all([fuelHistory(db, scope, filters, EXPORT_LIMIT), fuelBalances(db, scope, filters.from, filters.to)]);
    const frontLabel = scope.length === fronts.length && fronts.length > 1 ? "Todas as frentes" : fronts.filter((front) => scope.includes(front.id)).map((front) => front.name).join(", ") || "—";
    const fuelLabel = filters.fuelTypeId ? types.find((type) => type.id === filters.fuelTypeId)?.name ?? "—" : "Todos";
    const movementLabel = filters.movementType ? FUEL_MOVEMENT_LABELS[filters.movementType] : "Todos";
    const meter = (row: (typeof rows)[number]) => row.meterReading === null ? "" : `${liters(row.meterReading)} ${row.meterUnit === "KM" ? "km" : "h"}`;
    const frontText = (row: (typeof rows)[number]) => row.movementType === "TRANSFERENCIA" ? `${row.frontName} » ${row.destinationFrontName ?? "—"}` : row.frontName;
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);

    if (format === "pdf") {
      const pdf = createFuelHistoryPdf({
        generatedAt: formatPdfDate(now.toISOString()), total, truncated: total > rows.length,
        filters: { period: `${brDay(filters.from)} a ${brDay(filters.to)}`, front: frontLabel, fuel: fuelLabel, movement: movementLabel },
        balances: types.map((type) => { const balance = balances.get(type.id); return { fuel: type.name, balance: `${liters(balance?.balance ?? 0)} L`, entries: `${liters(balance?.entries ?? 0)} L`, exits: `${liters(balance?.exits ?? 0)} L` }; }),
        items: rows.map((row) => ({
          date: brDay(row.movementDate), type: row.movementLabel, fuel: row.fuelName, quantity: liters(row.quantity), front: frontText(row),
          equipment: row.equipmentPrefix ? `${row.equipmentPrefix} ${row.equipmentModel ?? ""}`.trim() : "—", origin: row.origin ?? "—", meter: meter(row) || "—", responsible: row.responsible ?? "—",
        })),
      });
      return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="combustivel-${stamp}.pdf"`, "Cache-Control": "private, no-store" } });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Sistema de Manutenção Preventiva — JC Serviços Florestais";
    workbook.created = now;
    const sheet = workbook.addWorksheet("Lançamentos");
    sheet.columns = [
      { header: "Data", key: "date", width: 12 },
      { header: "Tipo de movimentação", key: "type", width: 16 },
      { header: "Combustível", key: "fuel", width: 16 },
      { header: "Quantidade (L)", key: "quantity", width: 14 },
      { header: "Frente de serviço", key: "front", width: 18 },
      { header: "Filial destino", key: "destination", width: 18 },
      { header: "Veículo/Máquina", key: "equipment", width: 16 },
      { header: "Modelo", key: "model", width: 24 },
      { header: "Hodômetro/Horímetro", key: "meter", width: 16 },
      { header: "Origem", key: "origin", width: 22 },
      { header: "Responsável", key: "responsible", width: 22 },
      { header: "Observações", key: "notes", width: 30 },
      { header: "Lançado por", key: "createdBy", width: 22 },
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of rows) {
      sheet.addRow({
        date: new Date(`${row.movementDate}T12:00:00Z`), type: row.movementLabel, fuel: row.fuelName, quantity: row.quantity, front: row.frontName,
        destination: row.destinationFrontName ?? "", equipment: row.equipmentPrefix ?? "", model: row.equipmentModel ?? "", meter: meter(row),
        origin: row.origin ?? "", responsible: row.responsible ?? "", notes: row.notes ?? "", createdBy: row.createdByName ?? "",
      });
    }
    sheet.getColumn("date").numFmt = "dd/mm/yyyy";
    sheet.getColumn("quantity").numFmt = "#,##0.00";
    const summary = workbook.addWorksheet("Saldos");
    summary.columns = [
      { header: "Combustível", key: "fuel", width: 18 }, { header: "Frente", key: "front", width: 20 },
      { header: "Saldo atual (L)", key: "balance", width: 16 }, { header: "Entradas no período (L)", key: "entries", width: 20 }, { header: "Saídas no período (L)", key: "exits", width: 20 },
    ];
    summary.getRow(1).font = { bold: true };
    const frontName = new Map(fronts.map((front) => [front.id, front.name]));
    for (const type of types) {
      const balance = balances.get(type.id);
      summary.addRow({ fuel: type.name, front: frontLabel, balance: balance?.balance ?? 0, entries: balance?.entries ?? 0, exits: balance?.exits ?? 0 }).font = { bold: true };
      if (scope.length > 1) for (const id of scope) {
        const totals = balance?.byFront.get(id);
        summary.addRow({ fuel: "", front: frontName.get(id) ?? "—", balance: totals?.balance ?? 0, entries: totals?.entries ?? 0, exits: totals?.exits ?? 0 });
      }
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="combustivel-${stamp}.xlsx"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[fuel.export]", error);
    return Response.json({ error: "Não foi possível exportar os lançamentos agora." }, { status: 500 });
  }
}
