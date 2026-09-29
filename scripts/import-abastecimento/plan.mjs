import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Regras puras da importação do histórico de abastecimento (sem banco), usadas por
// importar-abastecimento.mjs e testadas em tests/import-abastecimento.test.mjs.
//
// Cada linha da aba "Dados_Limpos" vira um lançamento em fuel_movements:
//   - frente fixa (a frente informada no script, ex.: Arapiuns), estoque de origem = FRENTE;
//   - origin_confirmed = false (origem assumida; corrigir para Porto no Histórico quando for o caso);
//   - vehicle_pending = true quando o veículo é "A IDENTIFICAR" ou não existe no cadastro;
//   - import_source = lote; import_hash = hash da linha (não duplica se rodar de novo).
// Veículo, responsável e preço total podem vir vazios: a carga retroativa não passa pelas
// validações obrigatórias dos lançamentos novos.
// ---------------------------------------------------------------------------

export const SHEET_NAME = "Dados_Limpos";

export function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}
const compact = (value) => normalizeText(value).replace(/[^A-Z0-9]/g, "");

// Cabeçalhos aceitos (comparados sem acento/maiúsculas/espaços extras).
const COLUMNS = {
  date: ["DATA", "DATA/HORA", "DATA HORA"],
  fuel: ["TIPO COMBUSTIVEL", "TIPO DE COMBUSTIVEL", "COMBUSTIVEL"],
  movement: ["TIPO MOVIMENTACAO", "TIPO DE MOVIMENTACAO", "MOVIMENTACAO"],
  quantity: ["QUANTIDADE (L)", "QUANTIDADE", "QUANTIDADE L", "LITROS"],
  totalPrice: ["PRECO TOTAL", "VALOR TOTAL"],
  vehicle: ["VEICULO", "VEICULO/MAQUINA", "EQUIPAMENTO"],
  responsible: ["RESPONSAVEL"],
};
const REQUIRED = ["date", "fuel", "movement", "quantity"];

export function mapHeaders(headerCells) {
  const normalized = headerCells.map((cell) => normalizeText(cell));
  const indexes = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    const index = normalized.findIndex((cell) => names.includes(cell));
    if (index >= 0) indexes[key] = index;
  }
  const missing = REQUIRED.filter((key) => indexes[key] === undefined);
  return { indexes, missing: missing.map((key) => COLUMNS[key][0]) };
}

const pad = (value) => String(value).padStart(2, "0");
const validDay = (y, m, d) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

// Data/hora da planilha -> { day: "AAAA-MM-DD", stamp: "AAAA-MM-DD HH:MM:SS" } ou null.
// Datas do Excel chegam como Date em UTC representando a hora "de parede" (sem fuso).
export function parseDateTime(value) {
  if (value === null || value === undefined || value === "") return null;
  let y, m, d, hh = 0, mm = 0, ss = 0;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    y = value.getUTCFullYear(); m = value.getUTCMonth() + 1; d = value.getUTCDate();
    hh = value.getUTCHours(); mm = value.getUTCMinutes(); ss = value.getUTCSeconds();
  } else if (typeof value === "number") {
    // Número de série do Excel (dias desde 1899-12-30).
    const ms = Math.round((value - 25569) * 86400000);
    return parseDateTime(new Date(ms));
  } else {
    const text = String(value).trim();
    let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    if (match) { d = Number(match[1]); m = Number(match[2]); y = Number(match[3]); hh = Number(match[4] ?? 0); mm = Number(match[5] ?? 0); ss = Number(match[6] ?? 0); }
    else {
      match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
      if (!match) return null;
      y = Number(match[1]); m = Number(match[2]); d = Number(match[3]); hh = Number(match[4] ?? 0); mm = Number(match[5] ?? 0); ss = Number(match[6] ?? 0);
    }
  }
  if (!validDay(y, m, d) || hh > 23 || mm > 59 || ss > 59) return null;
  const day = `${y}-${pad(m)}-${pad(d)}`;
  return { day, stamp: `${day} ${pad(hh)}:${pad(mm)}:${pad(ss)}` };
}

// "1.234,56" / "1234.56" / 1234.56 -> número; vazio -> null; inválido -> NaN.
export function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const text = String(value).trim().replace(/[R$\s]/g, "");
  if (!text) return null;
  const normalized = text.includes(",") ? text.replaceAll(".", "").replace(",", ".") : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function parseMovementType(value) {
  const text = normalizeText(value);
  if (text.startsWith("ENTRADA")) return "ENTRADA";
  if (text.startsWith("SAIDA")) return "SAIDA";
  if (text.startsWith("TRANSF")) return "TRANSFERENCIA";
  return null;
}

// Tipo de combustível da planilha -> id em fuel_types (por nome ou código, sem acento/espaço).
export function resolveFuelType(value, fuelTypes) {
  const key = compact(value);
  if (!key) return null;
  const found = fuelTypes.find((type) => compact(type.name) === key || compact(type.code) === key)
    ?? (key.startsWith("ARLA") ? fuelTypes.find((type) => compact(type.name).startsWith("ARLA") || compact(type.code).startsWith("ARLA")) : undefined);
  return found ?? null;
}

export function isVehicleToIdentify(value) {
  return normalizeText(value).startsWith("A IDENTIFICAR");
}

// Veículo da planilha -> equipamento do cadastro, pelo prefixo (ou placa). Aceita "CA-01",
// "CA 01", "CA01" e textos que começam pelo prefixo ("CA-01 - CAMINHÃO"). Ambíguo = null.
export function buildEquipmentIndex(equipment) {
  const byKey = new Map();
  const add = (key, item) => { if (!key) return; const list = byKey.get(key) ?? []; if (!list.includes(item)) list.push(item); byKey.set(key, list); };
  for (const item of equipment) { add(compact(item.prefix), item); add(compact(item.plate), item); }
  return byKey;
}
export function matchEquipment(value, index) {
  const text = normalizeText(value);
  if (!text) return null;
  const candidates = [compact(text)];
  const first = /^([A-Z]{1,5})[\s-]*(\d{1,4})\b/.exec(text);
  if (first) candidates.push(`${first[1]}${first[2]}`, `${first[1]}${first[2].padStart(2, "0")}`);
  for (const key of candidates) {
    const list = index.get(key);
    if (list?.length === 1) return list[0];
  }
  return null;
}

export function buildEmployeeIndex(employees) {
  const byName = new Map();
  for (const item of employees) { const key = normalizeText(item.name); byName.set(key, byName.has(key) ? null : item); }
  return byName;
}

// Hash da linha: Data + Combustível + Movimentação + Quantidade + Veículo + Responsável.
export function rowHash({ stamp, fuel, movement, quantity, vehicle, responsible }) {
  const parts = [stamp, normalizeText(fuel), normalizeText(movement), Number(quantity).toFixed(3), normalizeText(vehicle), normalizeText(responsible)];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

const textOrNull = (value) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text || null; };

// rows = [{ rowNumber, cells: { date, fuel, movement, quantity, totalPrice, vehicle, responsible } }]
// destination = { frontId, location } do destino das transferências (origem é sempre a Frente).
export function buildImportPlan({ rows, fuelTypes, equipment, employees, existingHashes, frontId, importSource, fileName, destination }) {
  const equipmentIndex = buildEquipmentIndex(equipment);
  const employeeIndex = buildEmployeeIndex(employees);
  const seen = new Set();
  const items = [];
  for (const { rowNumber, cells } of rows) {
    const errors = [];
    const when = parseDateTime(cells.date);
    if (!when) errors.push("data inválida");
    const fuelType = resolveFuelType(cells.fuel, fuelTypes);
    if (!fuelType) errors.push(`combustível não cadastrado: "${textOrNull(cells.fuel) ?? "vazio"}"`);
    const movementType = parseMovementType(cells.movement);
    if (!movementType) errors.push(`tipo de movimentação inválido: "${textOrNull(cells.movement) ?? "vazio"}"`);
    const rawQuantity = parseNumber(cells.quantity);
    if (rawQuantity === null || Number.isNaN(rawQuantity) || rawQuantity === 0) errors.push("quantidade inválida");
    const quantity = rawQuantity && !Number.isNaN(rawQuantity) ? Math.abs(rawQuantity) : 0;
    const totalPrice = parseNumber(cells.totalPrice);
    if (Number.isNaN(totalPrice)) errors.push("preço total inválido");
    if (errors.length) { items.push({ rowNumber, status: "ERRO", error: errors.join("; ") }); continue; }

    const vehicleText = textOrNull(cells.vehicle);
    const responsibleText = textOrNull(cells.responsible);
    const hash = rowHash({ stamp: when.stamp, fuel: fuelType.name, movement: movementType, quantity, vehicle: vehicleText, responsible: responsibleText });
    if (seen.has(hash)) { items.push({ rowNumber, status: "DUPLICADO_NA_PLANILHA" }); continue; }
    seen.add(hash);
    if (existingHashes.has(hash)) { items.push({ rowNumber, status: "JA_EXISTE" }); continue; }

    // Veículo só se vincula na Saída (entrada/transferência não têm veículo no sistema).
    const toIdentify = vehicleText !== null && isVehicleToIdentify(vehicleText);
    const matched = movementType === "SAIDA" && vehicleText && !toIdentify ? matchEquipment(vehicleText, equipmentIndex) : null;
    // Pendente: "A IDENTIFICAR" (qualquer tipo) ou veículo da saída que não existe no cadastro.
    const vehiclePending = toIdentify || (movementType === "SAIDA" && vehicleText !== null && !matched);
    const employee = responsibleText ? employeeIndex.get(normalizeText(responsibleText)) ?? null : null;
    const transfer = movementType === "TRANSFERENCIA";
    const unitPrice = movementType === "ENTRADA" && totalPrice !== null && totalPrice > 0 ? Math.round((totalPrice / quantity) * 10000) / 10000 : null;
    const notes = [
      `Importado do histórico (${fileName}, linha ${rowNumber}).`,
      when.stamp.endsWith("00:00:00") ? null : `Data/hora original: ${when.stamp}.`,
      totalPrice !== null ? `Preço total na planilha: R$ ${totalPrice.toFixed(2)}.` : null,
      vehiclePending ? `Veículo na planilha: ${vehicleText}.` : null,
    ].filter(Boolean).join(" ");
    items.push({
      rowNumber, status: "IMPORTAR",
      vehicleReason: toIdentify ? "A_IDENTIFICAR" : vehiclePending ? "NAO_ENCONTRADO" : null,
      record: {
        serviceFrontId: frontId, fuelTypeId: fuelType.id, fuelName: fuelType.name, movementType, movementDate: when.day, quantity,
        stockLocation: "FRENTE", thirdParty: false, unitPrice,
        equipmentId: matched?.id ?? null, equipmentPrefix: matched?.prefix ?? null,
        destinationFrontId: transfer ? destination.frontId : null, destinationLocation: transfer ? destination.location : null,
        responsible: responsibleText, responsibleEmployeeId: employee?.id ?? null, notes,
        importSource, importHash: hash, originConfirmed: false, vehiclePending, importedVehicle: vehicleText,
      },
    });
  }
  const totals = {};
  for (const item of items) totals[item.status] = (totals[item.status] ?? 0) + 1;
  return { items, totals };
}

// Resumo por combustível / tipo de movimentação (quantidade de linhas e litros).
export function summarize(records) {
  const byFuel = new Map(); const byMovement = new Map();
  const add = (map, key, quantity) => { const value = map.get(key) ?? { rows: 0, liters: 0 }; value.rows += 1; value.liters += quantity; map.set(key, value); };
  for (const record of records) { add(byFuel, record.fuelName, record.quantity); add(byMovement, record.movementType, record.quantity); }
  return {
    byFuel, byMovement,
    vehiclePending: records.filter((record) => record.vehiclePending).length,
    originUnconfirmed: records.filter((record) => !record.originConfirmed).length,
    linkedVehicles: records.filter((record) => record.equipmentId).length,
    withEmployee: records.filter((record) => record.responsibleEmployeeId).length,
  };
}
