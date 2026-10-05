// Importar do sistema de pessoal — regras puras (sem banco), testadas em
// tests/personnel-import-rules.test.mjs. Lê a exportação já convertida em linhas (aba → registros)
// e monta, por pessoa ("ID sistema"), tudo o que a importação grava: cadastro, ciclos de folga,
// afastamentos, histórico de frentes e desligamentos. O casamento com o banco e a gravação ficam em
// lib/personnel-import.ts.
//
// Regras combinadas com o ADMIN (mapa aprovado):
// - "-", "—", "..." ou vazio = sem informação (nunca apaga valor existente).
// - Datas em DD/MM/AAAA ou AAAA-MM-DD; ano antes de 1900 (ex.: 01/01/0001) = sem informação.
// - Campos "(ficha)" têm preferência sobre os da lista.
// - Situação, dias restantes, dias em viagem, vencimento e dias trabalhados NÃO são importados: o
//   sistema calcula a partir das datas (lib/leave-cycle.ts).
// - Assinaturas, pendências e faltas da aba "Resumo por pessoa" são ignoradas.
// - Registro duplicado ("mesclado com o cadastro #id") não vira pessoa: o histórico vai para o #id.
// - "Desligado — teste" (e a reativação do mesmo dia) são ignorados.
// - Desligado → reativado → desligado no mesmo dia: vale só o último desligamento.
// - Ativo com "Desligado" sem "Reativado": a situação atual vale; o desligamento fica no histórico
//   como revertido na mesma data ("reativação não registrada na origem").
// - Ausências do tipo "Folga" não são importadas (a folga é o ciclo de folga).

export const PERSONNEL_SOURCE = "SISTEMA_PESSOAL";

export type Raw = Record<string, string | null>;
export type ExportSheets = Record<string, Raw[]>;

export const SHEETS = {
  colaboradores: "Colaboradores",
  resumo: "Resumo por pessoa",
  ciclos: "Ciclos de folga (painel)",
  historico: "Histórico de folgas",
  deFolga: "De folga",
  emViagem: "Em viagem",
  viagemRetorno: "Viagem de retorno",
  afastamentos: "Afastamentos",
  ausencias: "Ausências (por pessoa)",
  faltas: "Faltas",
  transferencias: "Transferências",
  movimentacoes: "Movimentações",
  restricao: "Lista de restrição",
} as const;

// Colunas mínimas de cada aba (as demais são opcionais).
export const REQUIRED_COLUMNS: Partial<Record<keyof typeof SHEETS, string[]>> = {
  colaboradores: ["Frente", "Lista", "Colaborador", "ID sistema"],
  ciclos: ["Colaborador", "Início do ciclo"],
  historico: ["Colaborador", "Ciclo", "Início", "Tipo"],
  deFolga: ["Colaborador", "Chegou em casa"],
  emViagem: ["Colaborador", "Saiu da frente"],
  ausencias: ["ID sistema", "Tipo", "Período"],
  movimentacoes: ["ID sistema", "Data", "Evento"],
  restricao: ["Colaborador"],
};

// ---------------------------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------------------------

export const nameKey = (value: string | null | undefined) =>
  String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export function noInfo(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || /^[-—–.]+$/.test(text) || text === "…") return null;
  return text;
}

const isoOk = (y: number, m: number, d: number) => {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

// DD/MM/AAAA ou AAAA-MM-DD → AAAA-MM-DD (null quando vazio ou inválido, inclusive 01/01/0001).
export function parseDate(value: unknown): string | null {
  const text = noInfo(value);
  if (!text) return null;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return isoOk(+match[1], +match[2], +match[3]) ? `${match[1]}-${match[2]}-${match[3]}` : null;
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return isoOk(+match[3], +match[2], +match[1]) ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : null;
  return null;
}

// "1.732,00" → 1732 (null quando vazio ou inválido).
export function parseMoney(value: unknown): number | null {
  const text = noInfo(value);
  if (!text) return null;
  const number = Number(text.replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export const onlyDigits = (value: string) => value.replace(/\D/g, "");

export function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// "Renascer" → "RENASCER" (mesma grafia da lista de empresas do cadastro).
export const companyName = (value: unknown) => (noInfo(value) ?? "").toUpperCase();

// ---------------------------------------------------------------------------------------------
// Colunas "grudadas"
// ---------------------------------------------------------------------------------------------

// "24/06/2026ciclo 1 · vence 22/09/2026" → início, nº do ciclo e vencimento (o vencimento é só
// conferência: o sistema calcula pelo ciclo de dias do funcionário).
export function parseCycleStart(value: unknown): { start: string; cycle: number; due: string | null } | null {
  const text = noInfo(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s*ciclo\s*(\d+)(?:\s*·\s*vence\s*(\d{1,2}\/\d{1,2}\/\d{4}))?/i);
  if (!match) return null;
  const start = parseDate(match[1]);
  return start ? { start, cycle: Number(match[2]), due: parseDate(match[3]) } : null;
}

// "08/07/2025 a 21/09/2026 — Afastado pelo INSS" / "26/09/2026 a em aberto" → início, retorno e motivo.
export function parsePeriod(value: unknown): { start: string; end: string | null; reason: string | null } | null {
  const text = noInfo(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s*a\s*(em aberto|\d{1,2}\/\d{1,2}\/\d{4})\s*(?:[—–-]\s*(.*))?$/i);
  if (!match) return null;
  const start = parseDate(match[1]);
  if (!start) return null;
  return { start, end: /aberto/i.test(match[2]) ? null : parseDate(match[2]), reason: noInfo(match[3]) };
}

export type MovementEvent =
  | { kind: "TRANSFER"; from: string | null; to: string }
  | { kind: "PLACED"; front: string }
  | { kind: "DISMISSED"; reason: string | null; test: boolean }
  | { kind: "REHIRED" };

// Evento da aba Movimentações.
export function parseMovement(value: unknown): MovementEvent | null {
  const text = noInfo(value);
  if (!text) return null;
  let match = text.match(/^Transferido de (.+?) para (.+)$/i);
  if (match) return { kind: "TRANSFER", from: noInfo(match[1])?.toUpperCase() ?? null, to: match[2].trim().toUpperCase() };
  match = text.match(/^Lotado no\(a\) (.+)$/i);
  if (match) return { kind: "PLACED", front: match[1].trim().toUpperCase() };
  match = text.match(/^Desligado\s*(?:[—–-]\s*(.*))?$/i);
  if (match) {
    const reason = noInfo(match[1]?.replace(/\s*[—–-]\s*$/, ""));
    return { kind: "DISMISSED", reason: reason && /^sem motivo informado$/i.test(reason) ? null : reason, test: /^teste$/i.test(reason ?? "") };
  }
  if (/^Reativad[oa]/i.test(text)) return { kind: "REHIRED" };
  return null;
}

// Registro duplicado: "(DUPLICADO - MESCLADO NO #411)" no nome ou "mesclado com o cadastro #291" no motivo.
export function duplicateTarget(name: unknown, reason: unknown): string | null {
  const fromName = String(name ?? "").match(/DUPLICADO\s*-\s*MESCLADO\s*NO\s*#(\d+)/i);
  if (fromName) return fromName[1];
  const fromReason = String(reason ?? "").match(/Registro duplicado.*#(\d+)/i);
  return fromReason ? fromReason[1] : null;
}

// ---------------------------------------------------------------------------------------------
// Funções
// ---------------------------------------------------------------------------------------------

// Grafias da origem que são a mesma função do cadastro (aprovado pelo ADMIN). Chave = nameKey.
export const FUNCTION_ALIASES: Record<string, string> = {
  [nameKey("MOT. DE CAMINHAO NIVEL III")]: "MOTORISTA DE CAMINHAO NIVEL III",
  [nameKey("MOT.DE CAMINHÃO NIVEL III")]: "MOTORISTA DE CAMINHAO NIVEL III",
  [nameKey("MOTORISTA DE CAMINHÃO NÍVEL III")]: "MOTORISTA DE CAMINHAO NIVEL III",
  [nameKey("AJUDANTE DE OPERADOR DE MOTOSSERRA")]: "AJUDANTE OPERADOR DE MOTOSSERRA",
  [nameKey("LAVADEIRA(O)")]: "LAVADEIRA",
  [nameKey("LAVADOR (A) DE ROUPAS")]: "LAVADEIRA",
};

export const normalizeFunction = (value: unknown) => (noInfo(value) ?? "").replace(/\s+/g, " ").toUpperCase();

// Grafia final da função (aplica os apelidos aprovados).
export function canonicalFunction(value: unknown, extraAliases: Record<string, string> = {}) {
  const name = normalizeFunction(value);
  const key = nameKey(name);
  return extraAliases[key] ?? FUNCTION_ALIASES[key] ?? name;
}

// "Opera equipamento": motoristas e operadores de máquinas (pá carregadeira, skidder, trator,
// motoniveladora, escavadeira...). Operador de motosserra e ajudantes NÃO.
export function operatesEquipment(functionName: string) {
  const key = nameKey(functionName);
  if (/MOTOSSERRA|^AJUD/.test(key)) return false;
  return /^(MOT |MOTORISTA)/.test(key)
    || /^(OP|OPERADOR) DE (PA CARREGADEIRA|SKIDDER|TRATOR|MOTONIVELADORA|ESCAVADEIRA|RETRO|MAQUINA|GUINDASTE|ROLO|CARREGADEIRA|FORWARDER|HARVESTER|FELLER)/.test(key);
}

// Funções que parecem a mesma (para mostrar na prévia): mesma chave sem abreviações e sem gênero.
export function functionLooseKey(value: string) {
  return nameKey(value)
    .replace(/\bMOT\b/g, "MOTORISTA").replace(/\bOP\b/g, "OPERADOR").replace(/\bAUX\b/g, "AUXILIAR").replace(/\bAJUD\b/g, "AJUDANTE")
    .replace(/\bENC\b/g, "ENCARREGADO").replace(/\bMEC\b/g, "MECANICO").replace(/\bTEC\b/g, "TECNICO")
    .replace(/\b(DE|DA|DO|DAS|DOS|E|A|O)\b/g, " ").replace(/\b(\w+?)(A|O)\b/g, "$1").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------
// Nomes parecidos
// ---------------------------------------------------------------------------------------------

export function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// Parecido: até 2 letras de diferença, ou um nome cortado (com ou sem "…") que é o começo do outro.
export function similarName(a: string, b: string) {
  const cut = (value: string) => value.replace(/[.…]+\s*$/, "");
  const ka = nameKey(cut(a)), kb = nameKey(cut(b));
  if (!ka || !kb || ka === kb) return false;
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (longer.startsWith(shorter) && shorter.length >= 20 && shorter.split(" ").length >= 3) return true;
  return Math.abs(ka.length - kb.length) <= 2 && levenshtein(ka, kb) <= 2;
}

// ---------------------------------------------------------------------------------------------
// Ciclo de folga
// ---------------------------------------------------------------------------------------------

export type CycleDates = { workStart: string | null; frontDeparture: string | null; homeArrival: string | null; homeDeparture: string | null; frontArrival: string | null };
const STEPS: Array<keyof CycleDates> = ["workStart", "frontDeparture", "homeArrival", "homeDeparture", "frontArrival"];
const STEP_LABELS: Record<keyof CycleDates, string> = { workStart: "início", frontDeparture: "saída da frente", homeArrival: "chegada em casa", homeDeparture: "saída de casa", frontArrival: "chegada na frente" };
const br = (day: string) => day.split("-").reverse().join("/");

// Datas fora de ordem na origem: de trás para a frente, uma etapa nunca fica depois da seguinte
// (mesma regra da importação anterior: "saída de casa depois da chegada na frente → usa a chegada").
// Devolve as datas ajustadas e o texto do ajuste (vai para as observações do ciclo).
export function fixCycleOrder(dates: CycleDates) {
  const fixed = { ...dates };
  const notes: string[] = [];
  let next: string | null = null;
  for (let index = STEPS.length - 1; index >= 0; index--) {
    const step = STEPS[index];
    const value = fixed[step];
    if (!value) continue;
    if (next && value > next) {
      notes.push(`${STEP_LABELS[step]} na origem: ${br(value)}`);
      fixed[step] = next;
    }
    next = fixed[step];
  }
  return { dates: fixed, notes };
}

export type CyclePhase = "SEM_CICLO" | "TRABALHANDO" | "VIAGEM_IDA" | "FOLGA" | "VIAGEM_VOLTA" | "FECHADO";
export function phaseOfDates(dates: CycleDates): CyclePhase {
  if (dates.frontArrival) return "FECHADO";
  if (dates.homeDeparture) return "VIAGEM_VOLTA";
  if (dates.homeArrival) return "FOLGA";
  if (dates.frontDeparture) return "VIAGEM_IDA";
  if (dates.workStart) return "TRABALHANDO";
  return "SEM_CICLO";
}

// ---------------------------------------------------------------------------------------------
// Plano por pessoa
// ---------------------------------------------------------------------------------------------

export type PlannedCycle = CycleDates & { cycleNumber: number; endedAt: string | null; leaveKind: "USUFRUIDA" | "VENDIDA"; notes: string | null; key: string };
export type PlannedAbsence = { kind: "ATESTADO" | "AFASTAMENTO"; startDate: string; endDate: string | null; notes: string | null; key: string };
export type PlannedTransfer = { date: string; from: string | null; to: string; note: string; key: string };
export type PlannedDismissal = { dismissedAt: string; reason: string; rehireAllowed: boolean; rehiredAt: string | null; key: string; current: boolean };

export type PlannedPerson = {
  externalId: string; row: number; name: string; front: string; company: string; registration: string | null; cpf: string | null;
  jobTitle: string; jobTitleOriginal: string; city: string | null; birthDate: string | null; admissionDate: string | null; salary: number | null;
  atHeadquarters: boolean; active: boolean; originSituation: string | null; restricted: boolean;
  cycles: PlannedCycle[]; absences: PlannedAbsence[]; transfers: PlannedTransfer[]; dismissals: PlannedDismissal[];
  status: "ATIVO" | "FOLGA" | "AFASTADO" | "DEMITIDO";
  warnings: string[]; errors: string[];
};

export type IgnoredRow = { sheet: string; row: number; name: string; reason: string };
export type SheetCount = { sheet: string; rows: number; used: number; ignored: number; note: string };

export type PersonnelPlan = {
  people: PlannedPerson[];
  ignored: IgnoredRow[];
  unlinked: IgnoredRow[];
  checks: string[];
  sheets: SheetCount[];
  exportDate: string | null;
  totals: { collaborators: number; active: number; dismissed: number; cycles: number; history: number; historyTaken: number; historySold: number; onLeave: number; traveling: number; restricted: number; restrictedRows: number };
  functions: Array<{ name: string; original: string[]; people: number; operates: boolean }>;
  looksAlike: Array<{ functions: string[] }>;
};

const ABSENCE_ON_LEAVE = /^folga$/i;
const DISMISSAL_DEFAULT = "Não informado (sistema de pessoal)";

// Pessoa da planilha por nome (abas sem "ID sistema"): nome único; empresa desempata.
function linker(people: PlannedPerson[]) {
  const byName = new Map<string, PlannedPerson[]>();
  for (const person of people) byName.set(nameKey(person.name), [...(byName.get(nameKey(person.name)) ?? []), person]);
  return (name: unknown, company?: unknown, registration?: string | null) => {
    // Linha do cadastro duplicado ("... (DUPLICADO - MESCLADO NO #340)") vai para o cadastro certo.
    const target = duplicateTarget(name, null);
    if (target) return people.find((person) => person.externalId === target) ?? null;
    const list = byName.get(nameKey(String(name ?? ""))) ?? [];
    if (list.length === 1) return list[0];
    const byCompany = list.filter((person) => !company || person.company === companyName(company));
    if (byCompany.length === 1) return byCompany[0];
    if (registration) {
      const byRegistration = people.filter((person) => person.registration === registration && (!company || person.company === companyName(company)));
      if (byRegistration.length === 1) return byRegistration[0];
    }
    return null;
  };
}

// `today` limita datas futuras (nenhuma etapa do ciclo pode ser futura).
export function buildPersonnelPlan(sheets: ExportSheets, today: string): PersonnelPlan {
  const get = (key: keyof typeof SHEETS) => sheets[SHEETS[key]] ?? [];
  const ignored: IgnoredRow[] = [];
  const unlinked: IgnoredRow[] = [];
  const checks: string[] = [];
  const sheetsCount: SheetCount[] = [];
  const allDates: string[] = [];
  const seen = (day: string | null) => { if (day) allDates.push(day); return day; };

  // 1) Colaboradores ------------------------------------------------------------------------
  const people: PlannedPerson[] = [];
  const redirect = new Map<string, string>(); // ID duplicado → ID certo
  const colab = get("colaboradores");
  colab.forEach((raw, index) => {
    const row = index + 2;
    const id = noInfo(raw["ID sistema"]);
    const listName = noInfo(raw["Colaborador"]) ?? "";
    if (!id) { ignored.push({ sheet: SHEETS.colaboradores, row, name: listName, reason: "Sem ID sistema" }); return; }
    const target = duplicateTarget(raw["Colaborador"], raw["Motivo"]);
    if (target) {
      redirect.set(id, target);
      ignored.push({ sheet: SHEETS.colaboradores, row, name: listName.replace(/\s*\(DUPLICADO.*$/i, ""), reason: `Registro duplicado — histórico vai para o cadastro #${target}` });
      return;
    }
    const dismissed = nameKey(raw["Lista"]) === "DESLIGADOS";
    const name = (noInfo(raw["Nome (ficha)"]) ?? listName).replace(/\s+/g, " ").toUpperCase();
    const original = noInfo(raw["Função (ficha)"]) ?? noInfo(raw["Colaborador - detalhe"]) ?? "";
    const cpf = noInfo(raw["CPF"]) ? onlyDigits(String(raw["CPF"])) : null;
    const birth = parseDate(raw["Nascimento (ficha)"]) ?? parseDate(raw["Nascimento"]);
    const admission = seen(parseDate(raw["Admissão (ficha)"]) ?? parseDate(raw["Admissão"]));
    const person: PlannedPerson = {
      externalId: id, row, name, front: nameKey(raw["Frente"]), company: companyName(noInfo(raw["Empresa (ficha)"]) ?? raw["Empresa"]),
      registration: noInfo(raw["Matrícula (ficha)"]) ?? noInfo(raw["Matrícula"]), cpf: cpf && cpf.length === 11 ? cpf : null,
      jobTitle: canonicalFunction(original), jobTitleOriginal: normalizeFunction(original),
      city: (noInfo(raw["Cidade (ficha)"]) ?? noInfo(raw["Cidade"]))?.toUpperCase() ?? null,
      birthDate: birth && admission && birth >= admission ? null : birth, admissionDate: admission, salary: parseMoney(raw["Salário CTPS"]),
      atHeadquarters: nameKey(raw["Fica na sede"]) === "SIM", active: !dismissed, originSituation: noInfo(raw["Situação"]),
      restricted: nameKey(raw["Restrição"]) === "RESTRITO",
      cycles: [], absences: [], transfers: [], dismissals: [], status: dismissed ? "DEMITIDO" : "ATIVO", warnings: [], errors: [],
    };
    if (noInfo(raw["Nascimento (ficha)"] ?? raw["Nascimento"]) && !birth) person.warnings.push("Nascimento inválido na origem (descartado)");
    if (birth && admission && birth >= admission) person.warnings.push("Nascimento depois da admissão na origem (descartado)");
    if (birth && birth < "1920-01-01") { person.birthDate = null; person.warnings.push("Nascimento improvável na origem (descartado)"); }
    if (!admission) person.warnings.push("Sem data de admissão válida na origem");
    if (cpf && cpf.length !== 11) person.warnings.push("CPF incompleto na origem (descartado)");
    if (dismissed) {
      const at = seen(parseDate(raw["Desligado em"]));
      const reason = noInfo(raw["Motivo"]) ?? DISMISSAL_DEFAULT;
      if (at) person.dismissals.push({ dismissedAt: at, reason, rehireAllowed: !person.restricted, rehiredAt: null, key: `deslig:${at}`, current: true });
      else person.warnings.push("Desligado sem data de desligamento na origem");
    }
    people.push(person);
  });
  const byId = new Map(people.map((person) => [person.externalId, person]));
  const resolveId = (id: string | null) => {
    let current = id;
    for (let hops = 0; current && redirect.has(current) && hops < 5; hops++) current = redirect.get(current)!;
    return current ? byId.get(current) ?? null : null;
  };
  const link = linker(people);
  sheetsCount.push({ sheet: SHEETS.colaboradores, rows: colab.length, used: people.length, ignored: colab.length - people.length, note: "Cadastro principal" });

  // 2) Resumo por pessoa (só conferência) ---------------------------------------------------
  const resumo = get("resumo");
  for (const raw of resumo) {
    const id = noInfo(raw["ID sistema"]);
    const person = id && !redirect.has(id) ? byId.get(id) : null;
    if (!person) continue;
    const diffs: string[] = [];
    if (noInfo(raw["Função"]) && normalizeFunction(raw["Função"]) !== person.jobTitleOriginal) diffs.push(`função ${raw["Função"]}`);
    if (noInfo(raw["Matrícula"]) && noInfo(raw["Matrícula"]) !== person.registration) diffs.push(`matrícula ${raw["Matrícula"]}`);
    if (noInfo(raw["Frente atual"]) && nameKey(raw["Frente atual"]) !== person.front) diffs.push(`frente ${raw["Frente atual"]}`);
    if (noInfo(raw["Status"]) && (nameKey(raw["Status"]) === "ATIVO") !== person.active) diffs.push(`status ${raw["Status"]}`);
    const admission = parseDate(raw["Admissão"]);
    if (admission && person.admissionDate && admission !== person.admissionDate) diffs.push(`admissão ${raw["Admissão"]}`);
    if (diffs.length) checks.push(`${person.name}: Resumo por pessoa difere de Colaboradores (${diffs.join("; ")})`);
  }
  sheetsCount.push({ sheet: SHEETS.resumo, rows: resumo.length, used: 0, ignored: resumo.length, note: "Só conferência (assinaturas, pendências e faltas ignoradas)" });

  // 3) Movimentações: frentes e desligamentos (por ID) --------------------------------------
  const moves = get("movimentacoes");
  const transfersSeen = new Set<string>();
  const addTransfer = (person: PlannedPerson, transfer: PlannedTransfer) => {
    const key = `${person.externalId}|${transfer.key}`;
    if (transfersSeen.has(key)) return false;
    transfersSeen.add(key);
    person.transfers.push(transfer);
    return true;
  };
  type Dismissal = { date: string; reason: string | null; rehiredAt: string | null; order: number };
  const dismissalEvents = new Map<PlannedPerson, Array<{ kind: "D" | "R"; date: string; reason: string | null; order: number }>>();
  let usedMoves = 0;
  moves.forEach((raw, index) => {
    const row = index + 2;
    const person = resolveId(noInfo(raw["ID sistema"]));
    const event = parseMovement(raw["Evento"]);
    if (!person) { unlinked.push({ sheet: SHEETS.movimentacoes, row, name: `ID ${raw["ID sistema"] ?? "?"}`, reason: "ID sistema não está na aba Colaboradores" }); return; }
    if (!event) { unlinked.push({ sheet: SHEETS.movimentacoes, row, name: person.name, reason: `Evento não reconhecido: ${raw["Evento"] ?? ""}` }); return; }
    const date = seen(parseDate(raw["Data"]));
    if ((event.kind === "DISMISSED" || event.kind === "REHIRED") && redirect.has(noInfo(raw["ID sistema"]) ?? "")) {
      ignored.push({ sheet: SHEETS.movimentacoes, row, name: person.name, reason: `${event.kind === "DISMISSED" ? "Desligamento" : "Reativação"} do cadastro duplicado (mesclado no #${person.externalId}) — não vale para a pessoa` });
      return;
    }
    if (event.kind === "TRANSFER") {
      if (!date) { unlinked.push({ sheet: SHEETS.movimentacoes, row, name: person.name, reason: "Transferência sem data válida" }); return; }
      if (addTransfer(person, { date, from: event.from ? nameKey(event.from) : null, to: nameKey(event.to), note: `Transferência (sistema de pessoal)`, key: `transf:${date}:${event.from ? nameKey(event.from) : "-"}:${nameKey(event.to)}` })) usedMoves++;
      return;
    }
    if (event.kind === "PLACED") {
      const day = date ?? person.admissionDate;
      if (!day) { unlinked.push({ sheet: SHEETS.movimentacoes, row, name: person.name, reason: "Lotação sem data válida" }); return; }
      if (addTransfer(person, { date: day, from: null, to: nameKey(event.front), note: `Lotado no(a) ${event.front} (sistema de pessoal)${date ? "" : " — data da origem inválida, usada a admissão"}`, key: `lotado:${day}:${nameKey(event.front)}` })) usedMoves++;
      return;
    }
    if (!date) { unlinked.push({ sheet: SHEETS.movimentacoes, row, name: person.name, reason: "Evento sem data válida" }); return; }
    if (event.kind === "DISMISSED" && event.test) {
      ignored.push({ sheet: SHEETS.movimentacoes, row, name: person.name, reason: "Desligado — teste (ignorado, com a reativação do mesmo dia)" });
      dismissalEvents.set(person, [...(dismissalEvents.get(person) ?? []), { kind: "D", date, reason: "__TESTE__", order: row }]);
      return;
    }
    dismissalEvents.set(person, [...(dismissalEvents.get(person) ?? []), event.kind === "DISMISSED" ? { kind: "D", date, reason: event.reason, order: row } : { kind: "R", date, reason: null, order: row }]);
    usedMoves++;
  });

  // 4) Transferências (por nome/matrícula): só completa o que Movimentações não trouxe -------
  const transfersSheet = get("transferencias");
  let usedTransfers = 0;
  transfersSheet.forEach((raw, index) => {
    const row = index + 2;
    const registration = String(raw["Colaborador - detalhe"] ?? "").match(/mat\.\s*(\d+)/i)?.[1] ?? null;
    const person = link(raw["Colaborador"], raw["Empresa"], registration);
    if (!person) { unlinked.push({ sheet: SHEETS.transferencias, row, name: String(raw["Colaborador"] ?? ""), reason: "Pessoa não encontrada em Colaboradores" }); return; }
    const date = seen(parseDate(raw["Data"]));
    const to = noInfo(raw["Para"]);
    if (!date || !to) return;
    const from = noInfo(raw["De"]);
    if (addTransfer(person, { date, from: from ? nameKey(from) : null, to: nameKey(to), note: "Transferência (sistema de pessoal)", key: `transf:${date}:${from ? nameKey(from) : "-"}:${nameKey(to)}` })) usedTransfers++;
  });
  sheetsCount.push({ sheet: SHEETS.transferencias, rows: transfersSheet.length, used: usedTransfers, ignored: transfersSheet.length - usedTransfers, note: "Duplicadas entre as frentes e com Movimentações são removidas" });

  // Desligamentos e reativações (por pessoa, em ordem de data e de linha).
  for (const [person, list] of dismissalEvents) {
    const events = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
    // Teste: some com a reativação seguinte do mesmo dia.
    for (let index = 0; index < events.length; index++) {
      if (events[index].reason !== "__TESTE__") continue;
      const next = events.findIndex((item, position) => position > index && item.kind === "R" && item.date === events[index].date);
      if (next >= 0) events.splice(next, 1);
      events.splice(index, 1);
      index--;
    }
    const result: Dismissal[] = [];
    for (const event of events) {
      if (event.kind === "D") {
        // Desligado → reativado → desligado no mesmo dia: vale só o último.
        const last = result.at(-1);
        if (last && last.date === event.date && last.rehiredAt === event.date) result.pop();
        result.push({ date: event.date, reason: event.reason, rehiredAt: null, order: event.order });
      } else {
        const open = [...result].reverse().find((item) => item.rehiredAt === null);
        if (open) open.rehiredAt = event.date;
      }
    }
    const current = person.dismissals.find((item) => item.current);
    result.forEach((item, index) => {
      const isLastOpen = index === result.length - 1 && item.rehiredAt === null;
      if (!person.active && isLastOpen) {
        // O desligamento atual vem de Colaboradores (data e motivo); a Movimentação só confere.
        if (current && current.dismissedAt !== item.date) checks.push(`${person.name}: desligamento em ${br(item.date)} na aba Movimentações e ${br(current.dismissedAt)} em Colaboradores (vale Colaboradores)`);
        if (current && current.reason === DISMISSAL_DEFAULT && item.reason) current.reason = item.reason;
        if (!current) person.dismissals.push({ dismissedAt: item.date, reason: item.reason ?? DISMISSAL_DEFAULT, rehireAllowed: !person.restricted, rehiredAt: null, key: `deslig:${item.date}`, current: true });
        return;
      }
      const rehiredAt = item.rehiredAt ?? item.date;
      const sameKey = person.dismissals.filter((other) => other.key.startsWith(`deslig:${item.date}`)).length;
      person.dismissals.push({
        dismissedAt: item.date, reason: (item.reason ?? DISMISSAL_DEFAULT) + (item.rehiredAt ? "" : " — reativação não registrada na origem"),
        rehireAllowed: true, rehiredAt, key: `deslig:${item.date}${sameKey ? `#${sameKey + 1}` : ""}`, current: false,
      });
      if (!item.rehiredAt) person.warnings.push(`Desligamento de ${br(item.date)} sem reativação na origem: registrado como revertido na mesma data`);
    });
  }
  sheetsCount.push({ sheet: SHEETS.movimentacoes, rows: moves.length, used: usedMoves, ignored: moves.length - usedMoves, note: "Transferências, lotações, desligamentos e reativações" });

  // 5) Lista de restrição (deduplicada por pessoa) -----------------------------------------
  const restriction = get("restricao");
  const restrictedPeople = new Set<PlannedPerson>();
  restriction.forEach((raw, index) => {
    const person = link(raw["Colaborador"], raw["Empresa"]);
    if (!person) { unlinked.push({ sheet: SHEETS.restricao, row: index + 2, name: String(raw["Colaborador"] ?? ""), reason: "Pessoa não encontrada em Colaboradores" }); return; }
    if (restrictedPeople.has(person)) return;
    restrictedPeople.add(person);
    person.restricted = true;
    const at = parseDate(raw["Desligado em"]);
    const reason = noInfo(raw["Motivo"]);
    let current = person.dismissals.find((item) => item.current);
    if (!current && at && !person.active) {
      current = { dismissedAt: at, reason: reason ?? DISMISSAL_DEFAULT, rehireAllowed: false, rehiredAt: null, key: `deslig:${at}`, current: true };
      person.dismissals.push(current);
    }
    if (current) {
      current.rehireAllowed = false;
      if (current.reason === DISMISSAL_DEFAULT && reason) current.reason = reason;
    } else person.warnings.push("Está na lista de restrição mas está ativo na origem (restrição não aplicada)");
  });
  sheetsCount.push({ sheet: SHEETS.restricao, rows: restriction.length, used: restrictedPeople.size, ignored: restriction.length - restrictedPeople.size, note: "Mesma pessoa repetida por frente: deduplicada" });

  // 6) Ciclos de folga ------------------------------------------------------------------------
  const blankCycle = (cycleNumber: number): PlannedCycle => ({ cycleNumber, workStart: null, frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null, endedAt: null, leaveKind: "USUFRUIDA", notes: null, key: `ciclo:${cycleNumber}` });
  const cycleOf = (person: PlannedPerson, cycleNumber: number) => {
    let cycle = person.cycles.find((item) => item.cycleNumber === cycleNumber);
    if (!cycle) { cycle = blankCycle(cycleNumber); person.cycles.push(cycle); }
    return cycle;
  };
  const openOf = (person: PlannedPerson) => [...person.cycles].sort((a, b) => b.cycleNumber - a.cycleNumber).find((item) => !item.frontArrival && !item.endedAt) ?? null;

  const history = get("historico");
  let historyTaken = 0, historySold = 0, usedHistory = 0;
  history.forEach((raw, index) => {
    const row = index + 2;
    const sold = nameKey(raw["Tipo"]) === "VENDIDA";
    if (sold) historySold++; else historyTaken++;
    const person = link(raw["Colaborador"], raw["Emp."]);
    if (!person) { unlinked.push({ sheet: SHEETS.historico, row, name: String(raw["Colaborador"] ?? ""), reason: "Pessoa não encontrada em Colaboradores" }); return; }
    const number = Number(noInfo(raw["Ciclo"]));
    if (!Number.isInteger(number) || number < 1) { unlinked.push({ sheet: SHEETS.historico, row, name: person.name, reason: "Número do ciclo inválido" }); return; }
    if (duplicateTarget(raw["Colaborador"], null) && person.cycles.some((item) => item.cycleNumber === number && item.workStart)) {
      ignored.push({ sheet: SHEETS.historico, row, name: person.name, reason: `Ciclo ${number} do cadastro duplicado — o cadastro certo já tem este ciclo` });
      return;
    }
    const { dates, notes } = fixCycleOrder({
      workStart: seen(parseDate(raw["Início"])), frontDeparture: seen(parseDate(raw["Saída"])), homeArrival: seen(parseDate(raw["Chegada casa"])),
      homeDeparture: seen(parseDate(raw["Saída casa"])), frontArrival: seen(parseDate(raw["Chegada frente"])),
    });
    const cycle = cycleOf(person, number);
    Object.assign(cycle, dates);
    if (notes.length) { cycle.notes = `Datas ajustadas na importação (${notes.join("; ")})`; person.warnings.push(`Ciclo ${number}: datas fora de ordem na origem (${notes.join("; ")})`); }
    if (sold) {
      cycle.leaveKind = "VENDIDA";
      const worked = Number(noInfo(raw["Dias trab."]));
      cycle.frontDeparture = cycle.homeArrival = cycle.homeDeparture = cycle.frontArrival = null;
      cycle.endedAt = cycle.workStart && Number.isFinite(worked) && worked > 0 ? addDays(cycle.workStart, worked) : cycle.workStart;
    }
    usedHistory++;
  });
  sheetsCount.push({ sheet: SHEETS.historico, rows: history.length, used: usedHistory, ignored: history.length - usedHistory, note: `${historyTaken} usufruídas, ${historySold} vendidas` });

  const panel = get("ciclos");
  let usedPanel = 0;
  panel.forEach((raw, index) => {
    const row = index + 2;
    const person = link(raw["Colaborador"], raw["Empresa"]);
    if (!person) { unlinked.push({ sheet: SHEETS.ciclos, row, name: String(raw["Colaborador"] ?? ""), reason: "Pessoa não encontrada em Colaboradores" }); return; }
    const parsed = parseCycleStart(raw["Início do ciclo"]);
    if (!parsed) return; // "Sem ciclo definido" / afastado: sem ciclo em andamento.
    seen(parsed.start);
    const cycle = cycleOf(person, parsed.cycle);
    if (cycle.workStart && cycle.workStart !== parsed.start) checks.push(`${person.name}: início do ciclo ${parsed.cycle} difere entre o painel (${br(parsed.start)}) e o histórico (${br(cycle.workStart)}) — vale o painel`);
    cycle.workStart = parsed.start;
    // O ciclo anterior vendido termina quando este começa.
    const previous = person.cycles.find((item) => item.cycleNumber === parsed.cycle - 1);
    if (previous?.leaveKind === "VENDIDA") previous.endedAt = parsed.start;
    usedPanel++;
  });
  sheetsCount.push({ sheet: SHEETS.ciclos, rows: panel.length, used: usedPanel, ignored: panel.length - usedPanel, note: "Ciclo atual (\"Sem ciclo definido\" e afastados não abrem ciclo)" });

  const traveling = get("emViagem");
  let usedTraveling = 0;
  traveling.forEach((raw, index) => {
    const row = index + 2;
    const person = link(raw["Colaborador"], raw["Empresa"]);
    if (!person) { unlinked.push({ sheet: SHEETS.emViagem, row, name: String(raw["Colaborador"] ?? ""), reason: "Pessoa não encontrada em Colaboradores" }); return; }
    const date = seen(parseDate(raw["Saiu da frente"]));
    if (!date) return;
    const cycle = openOf(person) ?? cycleOf(person, Math.max(0, ...person.cycles.map((item) => item.cycleNumber)) + 1);
    cycle.frontDeparture = date;
    usedTraveling++;
  });
  sheetsCount.push({ sheet: SHEETS.emViagem, rows: traveling.length, used: usedTraveling, ignored: traveling.length - usedTraveling, note: "Saída da frente do ciclo em aberto (dias em viagem: calculado)" });

  const onLeave = get("deFolga");
  let usedOnLeave = 0;
  onLeave.forEach((raw, index) => {
    const row = index + 2;
    const person = link(raw["Colaborador"], raw["Empresa"]);
    if (!person) { unlinked.push({ sheet: SHEETS.deFolga, row, name: String(raw["Colaborador"] ?? ""), reason: "Pessoa não encontrada em Colaboradores" }); return; }
    const date = seen(parseDate(raw["Chegou em casa"]));
    if (!date) return;
    const cycle = openOf(person) ?? cycleOf(person, Math.max(0, ...person.cycles.map((item) => item.cycleNumber)) + 1);
    cycle.homeArrival = date;
    usedOnLeave++;
  });
  sheetsCount.push({ sheet: SHEETS.deFolga, rows: onLeave.length, used: usedOnLeave, ignored: onLeave.length - usedOnLeave, note: "Chegada em casa do ciclo em aberto (dias restantes: calculado)" });

  for (const key of ["viagemRetorno", "faltas"] as const) {
    const rows = get(key).filter((raw) => !Object.keys(raw).every((column) => column === "Aviso"));
    sheetsCount.push({ sheet: SHEETS[key], rows: rows.length, used: 0, ignored: rows.length, note: rows.length ? "Não importada" : "Vazia — ignorada" });
  }

  // 7) Afastamentos + Ausências (sem duplicar) -----------------------------------------------
  const absenceSeen = new Set<string>();
  const addAbsence = (person: PlannedPerson, period: { start: string; end: string | null; reason: string | null }) => {
    const key = `${person.externalId}|${period.start}`;
    const existing = person.absences.find((item) => item.startDate === period.start);
    if (absenceSeen.has(key)) {
      if (existing && !existing.notes && period.reason) existing.notes = period.reason;
      return false;
    }
    absenceSeen.add(key);
    seen(period.start); seen(period.end);
    // Retorno informado = dia em que volta; o término gravado é o dia anterior (o sistema mostra
    // "volta" = dia seguinte ao término).
    const endDate = period.end ? (period.end > period.start ? addDays(period.end, -1) : period.start) : null;
    person.absences.push({ kind: /atestado/i.test(period.reason ?? "") ? "ATESTADO" : "AFASTAMENTO", startDate: period.start, endDate, notes: period.reason, key: `aus:${period.start}` });
    return true;
  };
  const absences = get("ausencias");
  let usedAbsences = 0, onLeaveAbsences = 0;
  absences.forEach((raw, index) => {
    const row = index + 2;
    if (ABSENCE_ON_LEAVE.test(noInfo(raw["Tipo"]) ?? "")) { onLeaveAbsences++; return; }
    const person = resolveId(noInfo(raw["ID sistema"]));
    if (!person) { unlinked.push({ sheet: SHEETS.ausencias, row, name: `ID ${raw["ID sistema"] ?? "?"}`, reason: "ID sistema não está na aba Colaboradores" }); return; }
    const period = parsePeriod(raw["Período"]);
    if (!period) { unlinked.push({ sheet: SHEETS.ausencias, row, name: person.name, reason: "Período inválido" }); return; }
    if (addAbsence(person, { ...period, reason: noInfo(raw["Motivo / observação"]) ?? period.reason })) usedAbsences++;
  });
  sheetsCount.push({ sheet: SHEETS.ausencias, rows: absences.length, used: usedAbsences, ignored: absences.length - usedAbsences, note: `${onLeaveAbsences} do tipo Folga não importadas (a folga é o ciclo)` });
  const leaves = get("afastamentos");
  let usedLeaves = 0;
  leaves.forEach((raw, index) => {
    const row = index + 2;
    const person = link(raw["Colaborador"]);
    if (!person) { unlinked.push({ sheet: SHEETS.afastamentos, row, name: String(raw["Colaborador"] ?? ""), reason: "Pessoa não encontrada em Colaboradores" }); return; }
    const period = parsePeriod(raw["Início · Retorno · Motivo"]);
    if (period && addAbsence(person, period)) usedLeaves++;
  });
  sheetsCount.push({ sheet: SHEETS.afastamentos, rows: leaves.length, used: usedLeaves, ignored: leaves.length - usedLeaves, note: "Mesmos afastamentos de Ausências: deduplicados" });

  // 8) Fechamento por pessoa -----------------------------------------------------------------
  const lastDate = allDates.filter((day) => day <= today).sort().at(-1) ?? null;
  for (const person of people) {
    person.cycles.sort((a, b) => a.cycleNumber - b.cycleNumber);
    // Ciclo fechado (chegada na frente) sem o próximo: o próximo começa nessa data (igual à tela).
    for (const cycle of [...person.cycles]) {
      if (!cycle.frontArrival || cycle.endedAt) continue;
      if (!person.cycles.some((item) => item.cycleNumber === cycle.cycleNumber + 1) && person.active) {
        person.cycles.push({ ...blankCycle(cycle.cycleNumber + 1), workStart: cycle.frontArrival });
      }
    }
    person.cycles.sort((a, b) => a.cycleNumber - b.cycleNumber);
    for (const cycle of person.cycles) {
      for (const step of STEPS) {
        if (cycle[step] && cycle[step]! > today) { person.warnings.push(`Ciclo ${cycle.cycleNumber}: ${STEP_LABELS[step]} futura na origem (descartada)`); cycle[step] = null; }
      }
      const fixed = fixCycleOrder(cycle);
      if (fixed.notes.length) { Object.assign(cycle, fixed.dates); cycle.notes = [cycle.notes, `Datas ajustadas na importação (${fixed.notes.join("; ")})`].filter(Boolean).join(" · "); }
    }
    // Ciclo vazio (nenhuma data) não é gravado.
    person.cycles = person.cycles.filter((cycle) => STEPS.some((step) => cycle[step]) || cycle.endedAt);
    const current = person.dismissals.find((item) => item.current);
    if (!person.active) {
      for (const cycle of person.cycles) if (!cycle.frontArrival && !cycle.endedAt) cycle.endedAt = current?.dismissedAt ?? lastDate;
      for (const absence of person.absences) if (current && (absence.endDate === null || absence.endDate > current.dismissedAt)) absence.endDate = absence.startDate > current.dismissedAt ? absence.startDate : current.dismissedAt;
      person.status = "DEMITIDO";
    } else {
      const open = person.cycles.find((cycle) => !cycle.frontArrival && !cycle.endedAt);
      const phase = open ? phaseOfDates(open) : "SEM_CICLO";
      const absent = person.absences.some((absence) => absence.startDate <= today && (absence.endDate === null || absence.endDate >= today));
      person.status = absent || nameKey(person.originSituation) === "AFASTADO" ? "AFASTADO" : phase === "VIAGEM_IDA" || phase === "FOLGA" || phase === "VIAGEM_VOLTA" ? "FOLGA" : "ATIVO";
    }
    // Primeira frente (sem lotação na origem): da admissão até a primeira transferência.
    const ordered = [...person.transfers].sort((a, b) => a.date.localeCompare(b.date));
    if (person.admissionDate && !ordered.some((item) => item.from === null && item.date <= (ordered[0]?.date ?? "9999"))) {
      const first = ordered.find((item) => item.from)?.from ?? person.front;
      if (first) person.transfers.push({ date: person.admissionDate, from: null, to: first, note: "Frente inicial (sistema de pessoal)", key: `inicial:${person.admissionDate}:${first}` });
    }
    // Ajustes da tela de cadastro (nome completo, admissão) — erros impedem só a criação de pessoa nova.
    if (person.name.split(" ").length < 2) person.errors.push("Nome sem sobrenome na origem");
    if (!person.admissionDate) person.errors.push("Sem data de admissão válida na origem");
    if (!person.front) person.errors.push("Sem frente na origem");
    if (!person.company) person.errors.push("Sem empresa na origem");
    if (!person.jobTitle) person.errors.push("Sem função na origem");
  }

  // Funções ----------------------------------------------------------------------------------
  const functionMap = new Map<string, { name: string; original: Set<string>; people: number }>();
  for (const person of people) {
    if (!person.jobTitle) continue;
    const item = functionMap.get(person.jobTitle) ?? { name: person.jobTitle, original: new Set<string>(), people: 0 };
    item.original.add(person.jobTitleOriginal);
    item.people++;
    functionMap.set(person.jobTitle, item);
  }
  const functions = [...functionMap.values()].map((item) => ({ name: item.name, original: [...item.original].sort(), people: item.people, operates: operatesEquipment(item.name) })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const loose = new Map<string, string[]>();
  for (const item of functions) loose.set(functionLooseKey(item.name), [...(loose.get(functionLooseKey(item.name)) ?? []), item.name]);
  const looksAlike = [...loose.values()].filter((list) => list.length > 1).map((list) => ({ functions: list }));

  const count = (list: PlannedPerson[], fn: (person: PlannedPerson) => boolean) => list.filter(fn).length;
  return {
    people, ignored, unlinked, checks, sheets: sheetsCount, exportDate: lastDate, functions, looksAlike,
    totals: {
      collaborators: colab.length, active: count(people, (person) => person.active), dismissed: colab.filter((raw) => nameKey(raw["Lista"]) === "DESLIGADOS").length,
      cycles: panel.length, history: history.length, historyTaken, historySold, onLeave: onLeave.length, traveling: traveling.length,
      restricted: restrictedPeople.size, restrictedRows: restriction.length,
    },
  };
}
