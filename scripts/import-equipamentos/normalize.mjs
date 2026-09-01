// Funções puras de normalização usadas tanto pelo importador quanto pelos testes.
// Nunca sobrescrevem o valor original: sempre devolvem uma versão adicional
// "normalizada", usada apenas para comparação/detecção de duplicidade.

const ABSENCE_VALUES = new Set([
  "",
  "#N/D",
  "SEM INFORMACAO",
  "SEM INFORMAÇÃO",
  "SEM INFORMAÇAO",
  "N TEM PLAQUETA",
  "Ñ TEM PLAQUETA",
  "NAO TEM PLAQUETA",
  "NÃO TEM PLAQUETA",
]);

function stripAccents(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function collapseSpaces(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Converte para NULL qualquer forma de "ausência de dado" (célula vazia,
// #N/D, SEM INFORMAÇÃO, Ñ TEM PLAQUETA, etc.), sem inventar valor nenhum.
export function emptyToNull(value) {
  const collapsed = collapseSpaces(value);
  if (!collapsed) return null;
  const withoutAccents = stripAccents(collapsed).toUpperCase();
  if (ABSENCE_VALUES.has(withoutAccents) || ABSENCE_VALUES.has(collapsed.toUpperCase())) return null;
  return collapsed;
}

// Chave de comparação do prefixo: maiúsculas, sem espaços/hífens/pontuação.
// "CA-01", "ca 01" e "CA01" comparam iguais por esta chave, mas o valor
// original digitado no arquivo é sempre preservado à parte.
export function prefixKey(value) {
  return stripAccents(String(value ?? ""))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// Prefixo "oficial" salvo no cadastro: maiúsculo, hífens normalizados, sem
// espaços — mas sem inventar hífen onde não existia (placas como KEF7F35
// continuam sem hífen).
export function canonicalPrefix(value) {
  return stripAccents(String(value ?? ""))
    .toUpperCase()
    .trim()
    .replace(/[–—_]+/g, "-")
    .replace(/\s+/g, "")
    .replace(/-+/g, "-");
}

// Categoria usada pelo motor de manutenção do sistema: letras antes do
// primeiro hífen do prefixo (CA, CM, JL, PC, SK, TE, ...). Prefixos sem
// hífen (placas) não têm categoria — ficam pendentes de configuração.
export function prefixCategory(value) {
  const canonical = canonicalPrefix(value);
  return canonical.includes("-") ? canonical.split("-")[0] : null;
}

const SERIAL_OBSERVATION_PATTERNS = [/^\d+\s*EIXOS?$/i];

// Identifica valores da coluna CHASSI/SERIE que claramente não são um
// chassi/série (ex.: "3 EIXOS"), para não gravar isso como se fosse um
// identificador do equipamento.
export function looksLikeObservationNotSerial(value) {
  const collapsed = collapseSpaces(value);
  if (!collapsed) return false;
  return SERIAL_OBSERVATION_PATTERNS.some((pattern) => pattern.test(collapsed));
}

export function serialKey(value) {
  const clean = emptyToNull(value);
  if (clean === null) return null;
  if (looksLikeObservationNotSerial(clean)) return null;
  return stripAccents(clean).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Placas antigas (AAA9999) e Mercosul (AAA9A99), com ou sem hífen.
const PLATE_PATTERN = /^[A-Z]{3}-?\d[A-Z0-9]\d{2}$/;

// Decide se o conteúdo da coluna PLACA é de fato uma placa veicular ou uma
// observação em texto livre (ex.: "ANTIGA JRL PC-01", "ANTIGA ILM 04").
// Observações nunca são gravadas no campo de placa.
export function classifyPlateField(value) {
  const clean = emptyToNull(value);
  if (clean === null) return { plate: null, observation: null };
  const compact = stripAccents(clean).toUpperCase().replace(/[\s-]/g, "");
  if (PLATE_PATTERN.test(compact) || /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(compact)) {
    return { plate: clean.toUpperCase(), observation: null };
  }
  return { plate: null, observation: clean };
}

// Normaliza um valor já confiável vindo do banco (chassi, série ou placa já
// cadastrados) para comparação — sem a heurística de "isso parece mesmo uma
// placa?" usada em classifyPlateField, que é só para dado bruto da planilha.
export function rawKey(value) {
  const clean = emptyToNull(value);
  if (clean === null) return null;
  return stripAccents(clean).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function plateKey(value) {
  const { plate } = classifyPlateField(value);
  if (!plate) return null;
  return stripAccents(plate).toUpperCase().replace(/[^A-Z0-9]/g, "");
}
