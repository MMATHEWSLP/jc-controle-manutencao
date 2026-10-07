import ExcelJS from "exceljs";
import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { eq } from "drizzle-orm";
import { thirdParties, thirdPartyVehicles } from "../../../../db/schema";
import { activeFuelTypes, fuelBalances, fuelHistory, fuelHistorySummary, fuelScopeFronts, fuelVisibleFronts, parseFuelFilters } from "../../../../lib/fuel";
import { FUEL_LOCATION_LABELS, FUEL_MOVEMENT_LABELS, PROVIDER_LABEL, THIRD_PARTY_LABEL } from "../../../../lib/fuel-rules";
import { createFuelHistoryPdf, formatPdfDate } from "../../../../lib/pdf";

// Exporta exatamente o Histórico exibido (mesma query string): ?formato=pdf | ?formato=xlsx.
const EXPORT_LIMIT = 5000;
const liters = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
// Formato brasileiro com unidade: 5.441 L, 1.234,50 L.
const litersBr = (value: number) => `${value.toLocaleString("pt-BR", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })} L`;
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
    const movementLabel = `${filters.movementType === "TERCEIROS" ? THIRD_PARTY_LABEL : filters.movementType === "PRESTADORES" ? PROVIDER_LABEL : filters.movementType ? FUEL_MOVEMENT_LABELS[filters.movementType] : "Todos"}${filters.location ? ` · ${FUEL_LOCATION_LABELS[filters.location]}` : ""}`;
    const meter = (row: (typeof rows)[number]) => row.meterReading === null ? "" : `${liters(row.meterReading)} ${row.meterUnit === "KM" ? "km" : "h"}`;
    type Row = (typeof rows)[number];
    // Origem = estoque (Frente/Porto). Na transferência mostra origem » destino.
    const originText = (row: Row) => {
      const origin = `${row.stockLocationLabel}${row.origin ? ` (${row.origin})` : ""}`;
      if (row.movementType !== "TRANSFERENCIA") return origin;
      const destination = row.destinationFrontId && row.destinationFrontId !== row.serviceFrontId ? `${row.destinationLocationLabel ?? "Frente"} ${row.destinationFrontName ?? ""}`.trim() : row.destinationLocationLabel ?? "Frente";
      return `${row.stockLocationLabel} » ${destination}`;
    };
    const receiver = (row: Row) => row.thirdParty
      ? row.thirdPartyKind === "PRESTADOR" ? `${row.providerCompany ?? "—"} · ${row.providerEquipment ?? "—"}` : `Terceiro: ${row.thirdPartyDescription ?? "—"}`
      : row.equipmentPrefix ? `${row.equipmentPrefix} ${row.equipmentModel ?? ""}`.trim() : row.vehiclePending ? `A identificar (${row.importedVehicle ?? "sem veículo"})` : "—";
    const money = (value: number | null) => value === null ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    // Entrada = valor total do lote; saída/transferência = custo médio do estoque de origem.
    const costText = (row: Row) => row.cost === null ? "sem valor" : money(row.cost);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);

    if (format === "pdf") {
      // Mesmas funções da tela (fuelHistory + fuelHistorySummary) com o mesmo filtro: o PDF nunca diverge.
      const summary = await fuelHistorySummary(db, scope, filters);
      const [party, vehicle] = await Promise.all([
        filters.thirdPartyId ? db.select({ name: thirdParties.name }).from(thirdParties).where(eq(thirdParties.id, filters.thirdPartyId)).limit(1).then((found) => found[0]?.name ?? null) : null,
        filters.vehicleId ? db.select({ plate: thirdPartyVehicles.plate, description: thirdPartyVehicles.description }).from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, filters.vehicleId)).limit(1).then((found) => found[0] ? [found[0].plate, found[0].description].filter(Boolean).join(" ") : null) : null,
      ]);
      const pendingLabels = { VEICULO: "Veículo a identificar", ORIGEM: "Origem a confirmar", IMPORTADOS: "Importados do histórico" } as const;
      const filterLines = [
        `Período: ${brDay(filters.from)} a ${brDay(filters.to)}`, `Frente: ${frontLabel}`, `Combustível: ${fuelLabel}`, `Movimentação: ${movementLabel}`,
        ...(party ? [`Empresa/terceiro: ${party}`] : []), ...(vehicle ? [`Veículo: ${vehicle}`] : []),
        ...(filters.q ? [`Busca: "${filters.q}"`] : []), ...(filters.pending ? [`Pendência: ${pendingLabels[filters.pending]}`] : []),
      ];
      const multiFuel = summary.byFuel.length > 1;
      const detail = (count: number, pick: (fuel: (typeof summary.byFuel)[number]) => { count: number; liters: number }) =>
        `${count} lançamento(s)${multiFuel ? ` · ${summary.byFuel.filter((fuel) => pick(fuel).count > 0).map((fuel) => `${fuel.fuelName} ${litersBr(pick(fuel).liters)}`).join(" · ")}` : ""}`;
      const cards = [
        ...(summary.show.entries ? [{ label: "Entradas", value: litersBr(summary.entries.liters), detail: detail(summary.entries.count, (fuel) => fuel.entries), tone: "green" as const }] : []),
        ...(summary.show.exits ? [{ label: "Saídas", value: litersBr(summary.exits.liters), detail: detail(summary.exits.count, (fuel) => fuel.exits), tone: "red" as const }] : []),
        ...(summary.show.transfers ? [{ label: "Transferências", value: litersBr(summary.transfers.liters), detail: detail(summary.transfers.count, (fuel) => fuel.transfers), tone: "blue" as const }] : []),
        ...(summary.balance !== null ? [{ label: "Saldo da movimentação", value: `${summary.balance > 0 ? "+" : ""}${litersBr(summary.balance)}`, detail: "entradas menos saídas no período", tone: summary.balance < 0 ? "red" as const : "green" as const }] : []),
      ];
      const company = (row: Row) => row.thirdPartyName ?? row.providerCompany ?? (row.thirdParty ? row.thirdPartyDescription : null) ?? "—";
      const plate = (row: Row) => row.vehiclePlate ?? row.providerEquipment ?? "—";
      const consumptionText = (row: Row) => row.consumption ? `${row.consumption.value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${row.consumption.unit}${row.consumptionOutlier ? " (fora)" : ""}`
        : row.thirdPartyVehicleId ? (row.fullTank === false ? "parcial" : "—") : "—";
      // Saídas de terceiros (filtro de prestadores/terceiros ou de empresa): colunas próprias.
      const thirdPartyLayout = filters.movementType === "PRESTADORES" || filters.movementType === "TERCEIROS" || filters.thirdPartyId !== null;
      const columns = thirdPartyLayout
        ? [{ x: 35, label: "DATA", max: 10 }, { x: 82, label: "TIPO", max: 21 }, { x: 170, label: "COMBUSTÍVEL", max: 12 }, { x: 232, label: "QTD. (L)", max: 10, align: "right" as const },
          { x: 280, label: "FRENTE", max: 12 }, { x: 345, label: "EMPRESA", max: 22 }, { x: 455, label: "VEÍCULO (PLACA)", max: 16 }, { x: 540, label: "LEITURA", max: 13 },
          { x: 610, label: "CONSUMO", max: 14 }, { x: 690, label: "RESPONSÁVEL", max: 22 }]
        : [{ x: 35, label: "DATA", max: 10 }, { x: 80, label: "TIPO", max: 20 }, { x: 160, label: "COMBUSTÍVEL", max: 11 }, { x: 220, label: "QTD. (L)", max: 9, align: "right" as const },
          { x: 266, label: "CUSTO", max: 11 }, { x: 320, label: "FRENTE", max: 11 }, { x: 376, label: "ORIGEM", max: 15 }, { x: 450, label: "VEÍCULO / EMPRESA · PLACA", max: 27 },
          { x: 590, label: "LEITURA", max: 11 }, { x: 648, label: "CONSUMO", max: 11 }, { x: 706, label: "RESPONSÁVEL", max: 18 }];
      // Rótulo curto para caber na coluna (o filtro no cabeçalho já diz o tipo por extenso).
      const typeText = (row: Row) => row.thirdParty ? (row.thirdPartyKind === "PRESTADOR" ? "Saída prestador" : "Saída terceiros") : row.movementLabel;
      const receiverText = (row: Row) => row.thirdParty ? `${company(row)} · ${plate(row)}` : receiver(row);
      const tableRows = rows.map((row) => thirdPartyLayout
        ? [brDay(row.movementDate), typeText(row), row.fuelName, litersBr(row.quantity), row.frontName, company(row), plate(row), meter(row) || "—", consumptionText(row), row.responsible ?? "—"]
        : [brDay(row.movementDate), typeText(row), row.fuelName, litersBr(row.quantity), costText(row), row.frontName, originText(row), receiverText(row), meter(row) || "—", consumptionText(row), row.responsible ?? "—"]);
      const pdf = createFuelHistoryPdf({
        generatedAt: formatPdfDate(now.toISOString()), generatedBy: user.name, filters: filterLines, cards,
        cardsNote: multiFuel ? `${summary.byFuel.length} combustíveis no filtro` : summary.byFuel[0]?.fuelName ?? "",
        total, truncated: total > rows.length, columns, rows: tableRows,
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
      { header: "Valor por litro (R$)", key: "unitCost", width: 14 },
      { header: "Custo / valor total (R$)", key: "cost", width: 16 },
      { header: "Frente de serviço", key: "front", width: 18 },
      { header: "Origem (estoque)", key: "origin", width: 18 },
      { header: "Destino da transferência", key: "destination", width: 22 },
      { header: "Veículo/Máquina", key: "equipment", width: 16 },
      { header: "Modelo", key: "model", width: 24 },
      { header: "Terceiro/Doações — destino/descrição", key: "thirdParty", width: 30 },
      { header: "Prestador — empresa", key: "providerCompany", width: 24 },
      { header: "Prestador — equipamento", key: "providerEquipment", width: 26 },
      { header: "Destino (terceiro)", key: "thirdPartyDestination", width: 28 },
      { header: "Finalidade", key: "purpose", width: 22 },
      { header: "Hodômetro/Horímetro", key: "meter", width: 16 },
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
        date: new Date(`${row.movementDate}T12:00:00Z`), type: row.movementLabel, fuel: row.fuelName, quantity: row.quantity, unitCost: row.unitCost, cost: row.cost, front: row.frontName,
        origin: `${row.stockLocationLabel}${row.origin ? ` (${row.origin})` : ""}`,
        destination: row.movementType === "TRANSFERENCIA" ? `${row.destinationFrontName ?? row.frontName} — ${row.destinationLocationLabel ?? "Frente"}` : "",
        equipment: row.equipmentPrefix ?? (row.vehiclePending ? `A identificar (${row.importedVehicle ?? "sem veículo"})` : ""), model: row.equipmentModel ?? "", thirdParty: row.thirdParty && row.thirdPartyKind !== "PRESTADOR" ? row.thirdPartyDescription ?? "" : "",
        providerCompany: row.providerCompany ?? "", providerEquipment: row.providerEquipment ?? "", meter: meter(row),
        thirdPartyDestination: row.destinationLabel ?? "", purpose: row.purposeLabel ?? "",
        responsible: row.responsible ?? "", notes: row.notes ?? "", createdBy: row.createdByName ?? "",
      });
    }
    sheet.getColumn("date").numFmt = "dd/mm/yyyy";
    sheet.getColumn("quantity").numFmt = "#,##0.00";
    sheet.getColumn("unitCost").numFmt = "#,##0.0000";
    sheet.getColumn("cost").numFmt = "#,##0.00";
    const summary = workbook.addWorksheet("Saldos");
    summary.columns = [
      { header: "Combustível", key: "fuel", width: 18 }, { header: "Frente", key: "front", width: 20 }, { header: "Estoque", key: "location", width: 12 },
      { header: "Saldo atual (L)", key: "balance", width: 16 }, { header: "Entradas no período (L)", key: "entries", width: 20 }, { header: "Saídas no período (L)", key: "exits", width: 20 },
    ];
    summary.getRow(1).font = { bold: true };
    const frontName = new Map(fronts.map((front) => [front.id, front.name]));
    const locations = [["FRENTE", "Frente"], ["PORTO", "Porto"]] as const;
    for (const type of types) {
      const balance = balances.get(type.id);
      summary.addRow({ fuel: type.name, front: frontLabel, location: "Total", balance: balance?.balance ?? 0, entries: balance?.entries ?? 0, exits: balance?.exits ?? 0 }).font = { bold: true };
      for (const [key, label] of locations) {
        const totals = balance?.byLocation[key];
        summary.addRow({ fuel: "", front: frontLabel, location: label, balance: totals?.balance ?? 0, entries: totals?.entries ?? 0, exits: totals?.exits ?? 0 });
      }
      if (scope.length > 1) for (const id of scope) for (const [key, label] of locations) {
        const totals = balance?.byFront.get(id)?.byLocation[key];
        summary.addRow({ fuel: "", front: frontName.get(id) ?? "—", location: label, balance: totals?.balance ?? 0, entries: totals?.entries ?? 0, exits: totals?.exits ?? 0 });
      }
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="combustivel-${stamp}.xlsx"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[fuel.export]", error);
    return Response.json({ error: "Não foi possível exportar os lançamentos agora." }, { status: 500 });
  }
}
