import ExcelJS from "exceljs";
import { and, asc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { equipment, maintenancePlans, maintenanceTypes, maintenances, serviceFronts, users } from "../../../db/schema";
import { authorize } from "../../../lib/auth";
import { frentesVisiveis } from "../../../lib/access";

const BATCH_SIZE = 1000;
const MAX_ROWS = 20000;

function canExportUser(user: { profile: string; canExport: boolean }) {
  return user.profile === "ADMIN" || user.profile === "GESTOR" || user.canExport;
}

function parseDateOnly(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function safeFilename(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-");
}

function brDate(value: string) {
  const iso = value.length === 10 ? `${value}T12:00:00Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadRows(where: ReturnType<typeof and>) {
  const db = await getDb();
  const rows: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (offset < MAX_ROWS) {
    const batch = await db
      .select({
        performedAt: maintenances.performedAt,
        hours: maintenances.hours,
        km: maintenances.km,
        mechanic: maintenances.mechanic,
        notes: maintenances.notes,
        equipmentPrefix: equipment.prefix,
        equipmentBrand: equipment.brand,
        equipmentModel: equipment.model,
        frontName: serviceFronts.name,
        maintenanceTypeName: maintenanceTypes.name,
        triggerMode: maintenancePlans.triggerMode,
        intervalHours: maintenancePlans.intervalHours,
        intervalKm: maintenancePlans.intervalKm,
        createdByName: users.name,
      })
      .from(maintenances)
      .innerJoin(equipment, eq(maintenances.equipmentId, equipment.id))
      .innerJoin(maintenanceTypes, eq(maintenances.maintenanceTypeId, maintenanceTypes.id))
      .leftJoin(serviceFronts, eq(maintenances.serviceFrontId, serviceFronts.id))
      .leftJoin(maintenancePlans, eq(maintenances.planId, maintenancePlans.id))
      .leftJoin(users, eq(maintenances.createdBy, users.id))
      .where(where)
      .orderBy(sql`substr(${maintenances.performedAt},1,10) DESC`, asc(equipment.sortKey))
      .limit(BATCH_SIZE)
      .offset(offset);
    rows.push(...batch);
    if (batch.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return rows;
}

export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canExportUser(user)) return Response.json({ error: "Você não possui permissão para exportar trocas de óleo." }, { status: 403 });

  try {
    const url = new URL(request.url);
    const start = parseDateOnly(url.searchParams.get("start"));
    const end = parseDateOnly(url.searchParams.get("end"));
    if (!start || !end) return Response.json({ error: "Informe o período (data inicial e final)." }, { status: 400 });

    const fronts = frentesVisiveis(user);
    const requestedFrontId = url.searchParams.get("serviceFrontId");
    const equipmentId = Number(url.searchParams.get("equipmentId"));
    const equipmentType = url.searchParams.get("equipmentType")?.trim() || "";
    const responsible = url.searchParams.get("responsible")?.trim() || "";

    if (requestedFrontId && requestedFrontId !== "ALL" && fronts !== "ALL" && !fronts.includes(Number(requestedFrontId))) {
      return Response.json({ error: "Você não possui acesso a esta frente de serviço." }, { status: 403 });
    }

    const conditions = [
      gte(maintenances.performedAt, `${start}T00:00:00.000Z`),
      lt(maintenances.performedAt, `${end}T23:59:59.999Z`),
    ];
    if (requestedFrontId && requestedFrontId !== "ALL") conditions.push(eq(maintenances.serviceFrontId, Number(requestedFrontId)));
    else if (fronts !== "ALL") conditions.push(fronts.length ? inArray(maintenances.serviceFrontId, fronts) : sql`1=0`);
    if (Number.isInteger(equipmentId) && equipmentId > 0) conditions.push(eq(maintenances.equipmentId, equipmentId));
    if (equipmentType) conditions.push(eq(equipment.type, equipmentType));
    if (responsible) conditions.push(or(ilike(maintenances.mechanic, `%${responsible}%`), ilike(users.name, `%${responsible}%`))!);

    const rows = await loadRows(and(...conditions));
    if (rows.length === 0) return Response.json({ error: "Nenhuma troca de óleo encontrada para o período e filtros selecionados." }, { status: 404 });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Sistema de Manutenção Preventiva";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Trocas de Óleo");
    sheet.columns = [
      { header: "Data da troca", key: "date", width: 14 },
      { header: "Frente de serviço", key: "front", width: 18 },
      { header: "Equipamento", key: "equipment", width: 14 },
      { header: "Modelo", key: "model", width: 26 },
      { header: "KM / Horímetro na troca", key: "reading", width: 20 },
      { header: "Tipo de serviço", key: "service", width: 30 },
      { header: "Responsável", key: "responsible", width: 20 },
      { header: "Próxima troca (KM/horímetro)", key: "next", width: 22 },
      { header: "Observações", key: "notes", width: 30 },
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
    header.alignment = { vertical: "middle" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: "I1" };

    const frontCounts = new Map<string, number>();
    const equipmentCounts = new Map<string, number>();

    for (const row of rows) {
      const isKm = row.triggerMode === "KM";
      const reading = isKm ? row.km : row.hours;
      const interval = isKm ? row.intervalKm : row.intervalHours;
      const next = reading !== null && reading !== undefined && interval !== null && interval !== undefined ? Number(reading) + Number(interval) : null;
      const unitLabel = isKm ? "km" : "h";
      const frontName = (row.frontName as string | null) ?? "Sem frente";
      const equipmentLabel = String(row.equipmentPrefix);
      frontCounts.set(frontName, (frontCounts.get(frontName) ?? 0) + 1);
      equipmentCounts.set(equipmentLabel, (equipmentCounts.get(equipmentLabel) ?? 0) + 1);

      sheet.addRow({
        date: brDate(String(row.performedAt)),
        front: frontName,
        equipment: equipmentLabel,
        model: `${row.equipmentBrand} ${row.equipmentModel}`,
        reading: reading === null || reading === undefined ? null : `${Number(reading).toLocaleString("pt-BR")} ${unitLabel}`,
        service: row.maintenanceTypeName,
        responsible: (row.mechanic as string | null) || (row.createdByName as string | null) || "Não informado",
        next: next === null ? "—" : `${next.toLocaleString("pt-BR")} ${unitLabel}`,
        notes: (row.notes as string | null) ?? "",
      });
    }
    sheet.getColumn("date").numFmt = "dd/mm/yyyy";
    sheet.getColumn("date").eachCell((cell, rowNumber) => { if (rowNumber > 1) cell.alignment = { horizontal: "center" }; });

    const summary = workbook.addWorksheet("Resumo");
    summary.columns = [
      { header: "Indicador", key: "label", width: 30 },
      { header: "Valor", key: "value", width: 20 },
    ];
    summary.getRow(1).font = { bold: true };
    summary.addRow({ label: "Total de trocas no período", value: rows.length });
    summary.addRow({});
    summary.addRow({ label: "Trocas por frente", value: "" }).font = { bold: true };
    for (const [front, count] of [...frontCounts.entries()].sort((a, b) => b[1] - a[1])) summary.addRow({ label: front, value: count });
    summary.addRow({});
    summary.addRow({ label: "Trocas por equipamento", value: "" }).font = { bold: true };
    for (const [prefix, count] of [...equipmentCounts.entries()].sort((a, b) => b[1] - a[1])) summary.addRow({ label: prefix, value: count });

    const buffer = await workbook.xlsx.writeBuffer();
    const frontSuffix = requestedFrontId && requestedFrontId !== "ALL" ? safeFilename((rows[0].frontName as string | null) ?? "frente") : "todas";
    const filename = `trocas-de-oleo_${frontSuffix}_${start.split("-").reverse().join("-")}_a_${end.split("-").reverse().join("-")}.xlsx`;

    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[maintenance-export-xlsx.get]", error);
    return Response.json({ error: "Não foi possível gerar a exportação agora." }, { status: 500 });
  }
}
