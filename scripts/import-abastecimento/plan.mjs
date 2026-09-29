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
// validações obrigatórias dos lançamentos novos. Combustíveis que não são usados no sistema
// (IGNORED_FUELS, ex.: ARLA 32) ficam de fora e aparecem no relatório como ignorados.
// ---------------------------------------------------------------------------

export const SHEET_NAME = "Dados_Limpos";
// Prefixos (sem acento/espaço) de combustíveis da planilha que não entram no sistema.
export const IGNORED_FUELS = ["ARLA"];

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

// Fuso das frentes (mesmo de lib/fuel.ts:fuelLocalDay).
const LOCAL_TIME = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

// Data/hora da planilha -> { day: "AAAA-MM-DD", stamp: "AAAA-MM-DD HH:MM:SS", hasTime } ou null.
// Datas da planilha limpa chegam como instante (meia-noite de Brasília = 03:00Z): o dia e a hora
// são os do fuso das frentes. hasTime = false para as datas "só dia" (00:00, ou 01:00 das linhas
// gravadas num fuso uma hora atrás).
export function parseDateTime(value) {
  if (value === null || value === undefined || value === "") return null;
  let y, m, d, hh = 0, mm = 0, ss = 0;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const parts = Object.fromEntries(LOCAL_TIME.formatToParts(value).map((part) => [part.type, part.value]));
    y = Number(parts.year); m = Number(parts.month); d = Number(parts.day);
    hh = Number(parts.hour); mm = Number(parts.minute); ss = Number(parts.second);
  } else if (typeof value === "number") {
    // Número de série do Excel (dias desde 1899-12-30), sem fuso: vale a hora "de parede".
    const date = new Date(Math.round((value - 25569) * 86400000));
    y = date.getUTCFullYear(); m = date.getUTCMonth() + 1; d = date.getUTCDate();
    hh = date.getUTCHours(); mm = date.getUTCMinutes(); ss = date.getUTCSeconds();
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
  return { day, stamp: `${day} ${pad(hh)}:${pad(mm)}:${pad(ss)}`, hasTime: !(hh <= 1 && mm === 0 && ss === 0) };
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
export function isIgnoredFuel(value, ignoredFuels = IGNORED_FUELS) {
  const key = compact(value);
  return key !== "" && ignoredFuels.some((prefix) => key.startsWith(compact(prefix)));
}

// missingFuel = nome do combustível a usar nas linhas com "Tipo Combustível" vazio (sem ele, são erro).
export function buildImportPlan({ rows, fuelTypes, equipment, employees, existingHashes, frontId, importSource, fileName, destination, ignoredFuels = IGNORED_FUELS, missingFuel = null }) {
  const equipmentIndex = buildEquipmentIndex(equipment);
  const employeeIndex = buildEmployeeIndex(employees);
  const seen = new Set();
  const items = [];
  for (const { rowNumber, cells } of rows) {
    if (isIgnoredFuel(cells.fuel, ignoredFuels)) { items.push({ rowNumber, status: "IGNORADO", fuel: textOrNull(cells.fuel) }); continue; }
    const errors = [];
    const when = parseDateTime(cells.date);
    if (!when) errors.push("data inválida");
    const fuelMissing = textOrNull(cells.fuel) === null && missingFuel !== null;
    const fuelType = resolveFuelType(fuelMissing ? missingFuel : cells.fuel, fuelTypes);
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
    const hash = rowHash({ stamp: when.stamp, fuel: fuelMissing ? "" : fuelType.name, movement: movementType, quantity, vehicle: vehicleText, responsible: responsibleText });
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
      fuelMissing ? `Combustível ausente na planilha — importado como ${fuelType.name}.` : null,
      when.hasTime ? `Data/hora original: ${when.stamp}.` : null,
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

// ---------------------------------------------------------------------------
// Ajuste de saldo (ajustar-saldo-combustivel.mjs): o saldo nunca é gravado, é a soma dos
// lançamentos. Para igualar ao saldo de outro sistema, entra um lançamento de ajuste (Entrada se
// falta combustível, Saída se sobra) por combustível/estoque, identificado por import_source.
// ---------------------------------------------------------------------------

// "Diesel S10:FRENTE=83174; Diesel S10:PORTO=16379,99" -> [{ fuel, location, target }]
export function parseBalanceTargets(text) {
  return String(text ?? "").split(/[;\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^(.+?):\s*(FRENTE|BASE|PORTO)\s*=\s*(-?[\d.,]+)$/i.exec(part);
    if (!match) throw new Error(`Saldo-alvo inválido: "${part}" (use Combustível:FRENTE=valor ou Combustível:PORTO=valor).`);
    const target = parseNumber(match[3]);
    if (target === null || Number.isNaN(target)) throw new Error(`Valor inválido em "${part}".`);
    const location = normalizeText(match[2]) === "PORTO" ? "PORTO" : "FRENTE";
    return { fuel: match[1].trim(), location, target };
  });
}

// current = (fuelTypeId, location) -> saldo atual. Devolve os lançamentos de ajuste (diferença ≠ 0).
export function planBalanceAdjustments({ targets, fuelTypes, current, frontId, date, importSource }) {
  return targets.map((item) => {
    const fuelType = resolveFuelType(item.fuel, fuelTypes);
    if (!fuelType) throw new Error(`Combustível não cadastrado: "${item.fuel}".`);
    const before = Math.round(current(fuelType.id, item.location) * 1000) / 1000;
    const diff = Math.round((item.target - before) * 1000) / 1000;
    const label = item.location === "PORTO" ? "Porto" : "Frente";
    const base = { fuelTypeId: fuelType.id, fuelName: fuelType.name, location: item.location, before, target: item.target, diff };
    if (Math.abs(diff) < 0.005) return { ...base, record: null };
    return {
      ...base,
      record: {
        serviceFrontId: frontId, fuelTypeId: fuelType.id, fuelName: fuelType.name, movementType: diff > 0 ? "ENTRADA" : "SAIDA", movementDate: date,
        quantity: Math.abs(diff), stockLocation: item.location, thirdParty: false, unitPrice: null, equipmentId: null,
        destinationFrontId: null, destinationLocation: null, responsible: null, responsibleEmployeeId: null,
        notes: `Ajuste de saldo (${label}) para igualar ao saldo do sistema anterior: ${before.toFixed(2)} L → ${item.target.toFixed(2)} L.`,
        importSource, importHash: createHash("sha256").update(["AJUSTE", importSource, frontId, fuelType.id, item.location, date, item.target.toFixed(3), before.toFixed(3)].join("|")).digest("hex"),
        originConfirmed: true, vehiclePending: false, importedVehicle: null,
      },
    };
  });
}
