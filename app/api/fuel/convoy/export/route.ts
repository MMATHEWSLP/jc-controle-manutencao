import ExcelJS from "exceljs";
import { inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { serviceFronts } from "../../../../../db/schema";
import { authorize } from "../../../../../lib/auth";
import { CONVOY_EXPORT_LIMIT, ConvoyError, convoyFilterOptions, listConvoyRecords, parseConvoyListFilters, type ConvoyListFilters } from "../../../../../lib/convoy";
import { CONVOY_STATUS_LABELS, NO_PHOTO_LABELS, type NoPhotoReason } from "../../../../../lib/convoy-rules";
import { createFuelHistoryPdf, formatPdfDate } from "../../../../../lib/pdf";

// Combustível → Aprovação → Histórico: exporta exatamente a lista da tela (mesmos filtros), em
// Excel (?formato=xlsx) ou PDF (?formato=pdf), com cabeçalho dos filtros, quem gerou e quando.
const STATUS_TEXT: Record<ConvoyListFilters["status"], string> = {
  TRATADOS: "Aprovados e rejeitados", TODOS: "Todas", ABERTOS: "Pendentes e correção", PENDENTE: "Pendentes", APROVADO: "Aprovados",
  REJEITADO: "Rejeitados", CORRECAO: "Correção pedida", APROVANDO: "Aprovando",
};
const brDay = (value: string | null) => (value ? value.slice(0, 10).split("-").reverse().join("/") : "");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const litersBr = (value: number) => `${value.toLocaleString("pt-BR", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })} L`;
const number = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });

export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const params = new URL(request.url).searchParams;
    const format = params.get("formato") === "xlsx" ? "xlsx" : "pdf";
    const filters: ConvoyListFilters = { ...parseConvoyListFilters(params), newestFirst: true, limit: CONVOY_EXPORT_LIMIT + 1 };
    const [found, options, fronts] = await Promise.all([
      listConvoyRecords(user, filters), convoyFilterOptions(user),
      filters.frontId ? (await getDb()).select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(inArray(serviceFronts.id, [filters.frontId])) : [],
    ]);
    const truncated = found.length > CONVOY_EXPORT_LIMIT;
    const records = found.slice(0, CONVOY_EXPORT_LIMIT);
    const label = (list: Array<{ id: number; label: string }>, id: number | null | undefined) => (id ? list.find((item) => item.id === id)?.label ?? `#${id}` : "Todos");
    const filterLines = [
      `Período: ${filters.from || filters.to ? `${brDay(filters.from) || "início"} a ${brDay(filters.to) || "hoje"}` : "todo o período"}`,
      `Frente: ${filters.frontId ? fronts[0]?.name ?? `#${filters.frontId}` : "Todas"}`,
      `Motorista do comboio: ${label(options.drivers, filters.driverId)}`, `Comboio: ${label(options.convoys, filters.convoyId)}`,
      `Equipamento: ${label(options.equipment, filters.equipmentId)}`, `Situação: ${STATUS_TEXT[filters.status]}`,
    ];
    const sum = (predicate: (item: (typeof records)[number]) => boolean) => records.filter(predicate).reduce((total, item) => total + item.liters, 0);
    const approved = records.filter((item) => item.status === "APROVADO");
    const rejected = records.filter((item) => item.status === "REJEITADO");
    const reading = (item: (typeof records)[number]) => (item.reading !== null ? `${number(item.reading)} ${item.unit === "KM" ? "km" : "h"}` : "");
    const photo = (item: (typeof records)[number]) => item.noPhoto ? `Sem foto${item.noPhotoReason ? ` (${NO_PHOTO_LABELS[item.noPhotoReason as NoPhotoReason]})` : ""}` : [item.hasMeterPhoto ? "medidor" : "", item.hasPumpPhoto ? "bomba" : ""].filter(Boolean).join(" + ") || "—";
    const treatedBy = (item: (typeof records)[number]) => item.approvedBy ? `${item.approvedBy} · ${when(item.approvedAt)}` : item.rejectedBy ? `${item.rejectedBy} · ${when(item.rejectedAt)}` : "";
    const corrections = (item: (typeof records)[number]) => item.corrections.map((change) => `${String(change.campo ?? "")}: ${String(change.de ?? "—")} → ${String(change.para ?? "—")} (${String(change.por ?? "")}${change.origem === "MOTORISTA" ? ", motorista" : ""})`).join("; ");
    const target = (item: (typeof records)[number]) => `${item.exitKind !== "FROTA" ? `${item.exitLabel}: ` : ""}${item.equipment}`;
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);

    if (format === "pdf") {
      const pdf = createFuelHistoryPdf({
        title: "COMBOIO · HISTÓRICO DA APROVAÇÃO", subtitle: "Abastecimentos do comboio já tratados, com os filtros abaixo",
        generatedAt: formatPdfDate(now.toISOString()), generatedBy: user.name, filters: filterLines,
        cards: [
          { label: "Registros", value: String(records.length), detail: `${litersBr(sum(() => true))} no total`, tone: "gray" },
          { label: "Aprovados", value: litersBr(sum((item) => item.status === "APROVADO")), detail: `${approved.length} registro(s)`, tone: "green" },
          { label: "Rejeitados", value: litersBr(sum((item) => item.status === "REJEITADO")), detail: `${rejected.length} registro(s)`, tone: "red" },
          { label: "Com correção", value: String(records.filter((item) => item.corrections.length > 0).length), detail: "registros com litros/leitura/equipamento corrigidos", tone: "blue" },
        ],
        cardsNote: "", total: records.length, truncated,
        columns: [
          { x: 34, label: "DATA/HORA", max: 16 }, { x: 104, label: "COMBOIO", max: 10 }, { x: 150, label: "REGISTROU", max: 18 }, { x: 236, label: "EQUIPAMENTO / TERCEIRO", max: 24 },
          { x: 346, label: "FRENTE", max: 14 }, { x: 410, label: "RECEBEU", max: 16 }, { x: 484, label: "LITROS", max: 10, align: "right" }, { x: 530, label: "LEITURA", max: 12 },
          { x: 588, label: "FOTO", max: 12 }, { x: 640, label: "SITUAÇÃO", max: 13 }, { x: 702, label: "APROVOU / REJEITOU", max: 24 },
        ],
        rows: records.map((item) => [when(item.recordedAt), item.convoy ?? "—", item.registeredBy ?? "—", target(item), item.front ?? "—", item.operatorName, litersBr(item.liters), reading(item) || "—",
          photo(item), `${CONVOY_STATUS_LABELS[item.status]}${item.corrections.length ? ` · ${item.corrections.length} corr.` : ""}`, treatedBy(item) || "—"]),
        emptyText: "Nenhum abastecimento do comboio para os filtros selecionados.",
        footer: "Lista gerada com os mesmos filtros da tela. As fotos ficam no sistema (Combustível → Aprovação → Histórico). Nenhum registro foi alterado.",
      });
      return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="comboio-historico-${stamp}.pdf"`, "Cache-Control": "private, no-store" } });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Sistema de Manutenção Preventiva — JC Serviços Florestais";
    workbook.created = now;
    const info = workbook.addWorksheet("Filtros");
    info.columns = [{ width: 28 }, { width: 60 }];
    info.addRow(["Comboio · Histórico da aprovação"]).font = { bold: true, size: 14 };
    info.addRow(["Gerado em", formatPdfDate(now.toISOString())]);
    info.addRow(["Gerado por", user.name]);
    for (const line of filterLines) { const [key, ...rest] = line.split(": "); info.addRow([key, rest.join(": ")]); }
    info.addRow(["Registros", records.length]);
    info.addRow(["Litros aprovados", Math.round(sum((item) => item.status === "APROVADO") * 100) / 100]);
    info.addRow(["Litros rejeitados", Math.round(sum((item) => item.status === "REJEITADO") * 100) / 100]);
    if (truncated) info.addRow(["Atenção", `Só os ${CONVOY_EXPORT_LIMIT} mais recentes — refine os filtros.`]);
    const sheet = workbook.addWorksheet("Abastecimentos");
    sheet.columns = [
      { header: "Data/hora", key: "at", width: 18 }, { header: "Data do abastecimento", key: "day", width: 14 }, { header: "Comboio", key: "convoy", width: 12 },
      { header: "Registrou (motorista do comboio)", key: "registeredBy", width: 26 }, { header: "Tipo", key: "kind", width: 16 }, { header: "Equipamento / terceiro", key: "target", width: 32 },
      { header: "Frente", key: "front", width: 20 }, { header: "Motorista/operador ou responsável que recebeu", key: "receiver", width: 30 }, { header: "Litros", key: "liters", width: 10 },
      { header: "Leitura", key: "reading", width: 12 }, { header: "Unidade", key: "unit", width: 8 }, { header: "Última leitura", key: "last", width: 14 }, { header: "Foto", key: "photo", width: 22 },
      { header: "Situação", key: "status", width: 18 }, { header: "Aprovado por", key: "approvedBy", width: 22 }, { header: "Aprovado em", key: "approvedAt", width: 18 },
      { header: "Rejeitado por", key: "rejectedBy", width: 22 }, { header: "Rejeitado em", key: "rejectedAt", width: 18 }, { header: "Motivo da rejeição", key: "rejection", width: 30 },
      { header: "Correções", key: "corrections", width: 50 }, { header: "Correção pedida ao motorista", key: "correctionNote", width: 30 }, { header: "Observação", key: "notes", width: 30 },
      { header: "Localização (mapa)", key: "map", width: 34 }, { header: "Nº do registro", key: "id", width: 10 },
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const item of records) {
      sheet.addRow({
        at: when(item.recordedAt), day: brDay(item.recordDate), convoy: item.convoy ?? "", registeredBy: item.registeredBy ?? "", kind: item.exitLabel, target: item.equipment,
        front: item.front ?? "", receiver: item.operatorName, liters: item.liters, reading: item.reading ?? "", unit: item.unit === "KM" ? "km" : item.unit === "HOURS" ? "h" : "",
        last: item.lastReading ?? "", photo: photo(item), status: CONVOY_STATUS_LABELS[item.status], approvedBy: item.approvedBy ?? "", approvedAt: when(item.approvedAt),
        rejectedBy: item.rejectedBy ?? "", rejectedAt: when(item.rejectedAt), rejection: item.rejectionReason ?? "", corrections: corrections(item), correctionNote: item.correctionNote ?? "",
        notes: item.notes ?? "", map: item.latitude !== null && item.longitude !== null ? `https://www.google.com/maps?q=${item.latitude},${item.longitude}` : "", id: item.id,
      });
    }
    sheet.getColumn("liters").numFmt = "#,##0.00";
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="comboio-historico-${stamp}.xlsx"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.export]", error);
    return Response.json({ error: "Não foi possível exportar o histórico do comboio." }, { status: 500 });
  }
}
