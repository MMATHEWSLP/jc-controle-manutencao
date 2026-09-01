import { readFileSync } from "node:fs";
import {
  canonicalPrefix,
  classifyPlateField,
  collapseSpaces,
  emptyToNull,
  looksLikeObservationNotSerial,
  plateKey,
  prefixCategory,
  prefixKey,
  serialKey,
} from "./normalize.mjs";

// Prefixos cujo "código" é, na verdade, a placa do veículo (não seguem o
// padrão LETRAS-NUMERO). Preservados como estão, mas sinalizados no
// relatório para conferência posterior, conforme pedido.
const PLATE_LIKE_PREFIX = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;

function parseYear(raw) {
  const clean = emptyToNull(raw);
  if (clean === null) return { year: null, alert: null };
  // Alguns registros trazem "2016/17" (ano de fabricação/modelo). Guardamos
  // o ano de fabricação (primeira parte) e não inventamos o restante.
  const match = clean.match(/^(\d{4})(?:\/(\d{2,4}))?$/);
  if (!match) return { year: null, alert: `Ano "${clean}" não reconhecido` };
  return { year: Number(match[1]), alert: null };
}

function splitColumns(line) {
  if (line.includes("\t")) return line.split("\t");
  // Fallback defensivo caso o arquivo de origem venha com espaços múltiplos
  // em vez de tabulação de verdade.
  return line.split(/ {2,}/);
}

export function parseFleetSource(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => collapseSpaces(line).length > 0);
  const [header, ...dataLines] = lines;
  if (!header || !/DESCRIÇÃO|DESCRICAO/i.test(header)) {
    throw new Error(`Cabeçalho inesperado em ${filePath}: "${header}"`);
  }

  const rows = dataLines.map((line, index) => {
    const columns = splitColumns(line);
    const prefixRaw = collapseSpaces(columns[0]);
    const description = collapseSpaces(columns[1]);
    const serialRaw = emptyToNull(columns[2]);
    const { year, alert: yearAlert } = parseYear(columns[3]);
    const plateRaw = emptyToNull(columns[4]);

    const alerts = [];
    if (yearAlert) alerts.push(yearAlert);

    const isPlateLikePrefix = PLATE_LIKE_PREFIX.test(canonicalPrefix(prefixRaw));
    if (isPlateLikePrefix) alerts.push("Prefixo é uma placa (código de série antigo) — conferir manualmente");

    // Configurações de eixo tipo "NxM" só existem com M<=N (4x2, 4x4, 6x2,
    // 6x4, 6x6, 8x4...). "4X5" (CA-06) não existe de fábrica — provável erro
    // de digitação na planilha de origem; sinalizamos sem corrigir sozinho.
    const axleMatch = description.match(/\b(\d)\s*[xX]\s*(\d)\b/);
    if (axleMatch && Number(axleMatch[2]) > Number(axleMatch[1])) {
      alerts.push(`Configuração de eixo "${axleMatch[0]}" incomum — conferir descrição junto ao fabricante`);
    }

    let serialForStorage = serialRaw;
    if (serialRaw !== null && looksLikeObservationNotSerial(serialRaw)) {
      alerts.push(`Coluna CHASSI/SÉRIE contém observação, não um identificador: "${serialRaw}"`);
      serialForStorage = null;
    }

    const { plate, observation: plateObservation } = classifyPlateField(plateRaw);
    if (plateObservation) alerts.push(`Coluna PLACA contém observação, preservada como nota: "${plateObservation}"`);

    if (serialForStorage === null && plate === null && !plateObservation) {
      alerts.push("Sem chassi/série e sem placa — dados incompletos");
    }

    return {
      rowNumber: index + 2, // +2: linha 1 é o cabeçalho, planilhas começam em 1
      prefixRaw,
      prefixKey: prefixKey(prefixRaw),
      prefixCanonical: canonicalPrefix(prefixRaw),
      category: prefixCategory(prefixRaw),
      description,
      year,
      serialRaw: serialForStorage,
      serialKey: serialKey(serialForStorage),
      plate,
      plateKey: plateKey(plateRaw),
      plateObservation,
      isPlateLikePrefix,
      alerts,
    };
  });

  return { header, rows };
}

// Detecta duplicidade dentro do próprio arquivo de entrada (antes mesmo de
// comparar com o banco), agrupando por prefixo, série e placa normalizados.
export function findInternalDuplicates(rows) {
  const byKey = (key) => {
    const map = new Map();
    for (const row of rows) {
      const value = row[key];
      if (value === null) continue;
      if (!map.has(value)) map.set(value, []);
      map.get(value).push(row);
    }
    return [...map.entries()].filter(([, list]) => list.length > 1);
  };
  return {
    prefix: byKey("prefixKey"),
    serial: byKey("serialKey"),
    plate: byKey("plateKey"),
  };
}

function trailingDigits(value) {
  const match = value.match(/(\d+)$/);
  return match ? match[1] : "";
}

// Além de série idêntica, sinaliza pares que compartilham a mesma série
// contida dentro da outra, OU o mesmo número sequencial final (>=5 dígitos)
// — caso do TE-09 "LJR00617" e TE-10 "CAT00D6NJLR00617" (mesmo número de
// série de fábrica, prefixo do fabricante grafado de forma diferente).
export function findSubstringSerialConflicts(rows) {
  const withSerial = rows.filter((row) => row.serialKey && row.serialKey.length >= 6);
  const pairs = [];
  for (let i = 0; i < withSerial.length; i++) {
    for (let j = i + 1; j < withSerial.length; j++) {
      const a = withSerial[i];
      const b = withSerial[j];
      if (a.serialKey === b.serialKey) continue; // já coberto por findInternalDuplicates
      const substringMatch = a.serialKey.includes(b.serialKey) || b.serialKey.includes(a.serialKey);
      const tailA = trailingDigits(a.serialKey);
      const tailB = trailingDigits(b.serialKey);
      const tailMatch = tailA.length >= 5 && tailA === tailB;
      if (substringMatch || tailMatch) pairs.push([a, b]);
    }
  }
  return pairs;
}
