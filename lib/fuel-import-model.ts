import ExcelJS from "exceljs";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { getDb } from "../db";
import { equipment, fuelTypes, serviceFronts, thirdParties, thirdPartyVehicles } from "../db/schema";
import type { SessionUser } from "./auth";
import { fuelVisibleFronts } from "./fuel";
import { FUEL_IMPORT_COLUMNS, FUEL_IMPORT_HELP, FUEL_IMPORT_TYPES, type FuelImportValues } from "./fuel-import-rules";

// ---------------------------------------------------------------------------
// Gerador do modelo da importação de abastecimentos (.xlsx): aba "Lançamentos" (cabeçalho exato,
// opcionalmente já com linhas), "Instruções" e "Listas" (frentes, combustíveis, equipamentos ativos e
// veículos de terceiros). Usado pelo "Baixar modelo", pelo "baixar linhas com erro" e pelo leitor
// de fichas — o arquivo é sempre gerado aqui, no servidor.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;

export async function buildFuelImportWorkbook(db: Db, user: SessionUser, rows: Array<{ values: FuelImportValues; error?: string }> = []) {
  const [fronts, types, fleet, vehicles] = await Promise.all([
    fuelVisibleFronts(db, user),
    db.select({ name: fuelTypes.name }).from(fuelTypes).where(eq(fuelTypes.active, true)).orderBy(asc(fuelTypes.sortOrder), asc(fuelTypes.name)),
    db.select({ prefix: equipment.prefix, plate: equipment.plate, type: equipment.type, brand: equipment.brand, model: equipment.model, front: serviceFronts.name, controlType: equipment.controlType })
      .from(equipment).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId)).where(and(isNull(equipment.soldAt), eq(equipment.status, "ACTIVE"))).orderBy(asc(equipment.sortKey)),
    db.select({ company: thirdParties.name, plate: thirdPartyVehicles.plate, description: thirdPartyVehicles.description, meterType: thirdPartyVehicles.meterType })
      .from(thirdPartyVehicles).innerJoin(thirdParties, eq(thirdParties.id, thirdPartyVehicles.thirdPartyId))
      .where(and(eq(thirdPartyVehicles.active, true), eq(thirdParties.active, true))).orderBy(asc(thirdParties.name), asc(thirdPartyVehicles.plate)),
  ]);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sistema de Manutenção Preventiva — JC Serviços Florestais";
  workbook.created = new Date();
  const hasErrors = rows.some((row) => row.error);
  const sheet = workbook.addWorksheet("Lançamentos", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    ...FUEL_IMPORT_COLUMNS.map((column) => ({ header: column, key: column, width: column === "observacao" ? 36 : column === "equipamento" || column === "motorista" || column === "origem" ? 20 : 14, style: { numFmt: "@" } })),
    ...(hasErrors ? [{ header: "erro", key: "erro", width: 60 }] : []),
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
  for (const row of rows) sheet.addRow({ ...row.values, ...(hasErrors ? { erro: row.error ?? "" } : {}) });

  const help = workbook.addWorksheet("Instruções");
  help.columns = [{ header: "coluna", key: "column", width: 16 }, { header: "obrigatória", key: "required", width: 30 }, { header: "formato", key: "format", width: 70 }, { header: "exemplo", key: "example", width: 30 }];
  help.getRow(1).font = { bold: true };
  for (const column of FUEL_IMPORT_COLUMNS) help.addRow({ column, ...FUEL_IMPORT_HELP[column] });
  help.addRow({});
  for (const line of [
    "Uma linha por abastecimento, na aba Lançamentos. Não mude os nomes nem a ordem das colunas.",
    "Nada é gravado ao enviar o arquivo: o sistema mostra a prévia (OK, AVISO ou ERRO) e só grava depois de \"Confirmar importação\".",
    "Linhas do mesmo equipamento no mesmo dia são importadas na ordem da planilha.",
    "Duplicado = mesmo equipamento + data + litros + leitura já lançados (no sistema ou na própria planilha).",
    "Tipos: SAIDA_FROTA (equipamento da JC), SAIDA_TERCEIRO (empresa ou pessoa) e SAIDA_PRESTADOR (prestador de serviço).",
  ]) help.addRow({ column: line });

  const lists = workbook.addWorksheet("Listas");
  lists.columns = [
    { header: "frentes", key: "front", width: 22 }, { header: "combustiveis", key: "fuel", width: 18 }, { header: "tipos", key: "type", width: 18 }, { header: "", key: "gap", width: 3 },
    { header: "equipamento (código)", key: "prefix", width: 18 }, { header: "placa", key: "plate", width: 12 }, { header: "tipo / modelo", key: "model", width: 34 }, { header: "frente", key: "equipmentFront", width: 18 }, { header: "leitura", key: "unit", width: 10 }, { header: "", key: "gap2", width: 3 },
    { header: "empresa (terceiro)", key: "company", width: 24 }, { header: "placa do veículo", key: "vehiclePlate", width: 16 }, { header: "veículo", key: "vehicle", width: 26 }, { header: "leitura ", key: "vehicleUnit", width: 10 },
  ];
  lists.getRow(1).font = { bold: true };
  const total = Math.max(fronts.length, types.length, FUEL_IMPORT_TYPES.length, fleet.length, vehicles.length);
  for (let index = 0; index < total; index++) {
    const item = fleet[index], vehicle = vehicles[index];
    lists.addRow({
      front: fronts[index]?.name ?? "", fuel: types[index]?.name ?? "", type: FUEL_IMPORT_TYPES[index] ?? "",
      prefix: item?.prefix ?? "", plate: item?.plate ?? "", model: item ? `${item.type} · ${item.brand} ${item.model}`.trim() : "", equipmentFront: item?.front ?? "", unit: item ? (item.controlType === "KM" ? "km" : "horímetro") : "",
      company: vehicle?.company ?? "", vehiclePlate: vehicle?.plate ?? "", vehicle: vehicle?.description ?? "", vehicleUnit: vehicle ? (vehicle.meterType === "KM" ? "km" : "horímetro") : "",
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
