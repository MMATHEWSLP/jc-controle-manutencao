import ExcelJS from "exceljs";
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getD1, getDb } from "../db";
import { auditLogs, dailyImportBatches, dailyProblemReports, dailyRecords, equipment, fuelMovements, meterReadings, serviceFronts, users } from "../db/schema";
import type { SessionUser } from "./auth";
import {
  casarPorPrefixo, chaveEquipamento, conferirLeituras, DIESEL_LIMITE_LITROS, gruposDeEscala, lerLinhaDiario, mapearCabecalhoDiario, mesDoLote, MOTIVO_ROTULO,
  nameKey, sugerirEquipamento, totaisDiario, type LinhaDiario,
} from "./daily-import-rules";
import { readingUnitFor } from "./daily-record-rules";
import { semelhanca, SEMELHANCA_ROTULO } from "./field-operators-rules";
import { buildAlertStatements, loadEquipmentCore, loadPlansForEquipment, loadThresholds } from "./maintenance-data";
import { recalculateMaintenanceCycles } from "./maintenance-recalculation";

// ---------------------------------------------------------------------------
// Importação do Controle Diário (Controle Diário → Importar planilha, só ADMIN).
//  1. Prévia (nada é gravado): liga equipamento, frente e operador aos cadastros, separa as linhas
//     "Conferir", os já existentes, o diesel acima de 600 L e os problemas relatados.
//  2. Confirmar: cria o lote com o plano aprovado; os registros entram em blocos de até 500
//     (uma requisição por bloco, para não estourar o tempo da hospedagem).
//  3. Finalizar: sobe a leitura atual dos equipamentos (só a mais recente e maior), recalcula ciclos
//     de troca de óleo e alertas.
//  4. Desfazer: apaga registros, leituras e problemas do lote e devolve a leitura dos equipamentos.
// O diesel do diário NUNCA vira saída de combustível nem mexe em saldo.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
export const BLOCO = 500;

export class DailyImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function exigeAdmin(user: SessionUser) {
  if (user.profile !== "ADMIN") throw new DailyImportError("Só ADMIN importa a planilha do Controle Diário.", 403);
}

const cel = (valor: ExcelJS.CellValue): unknown => {
  if (valor && typeof valor === "object" && !(valor instanceof Date)) {
    if ("result" in valor) return valor.result;
    if ("richText" in valor) return valor.richText.map((parte) => parte.text).join("");
    if ("text" in valor) return valor.text;
    return null;
  }
  return valor;
};

export async function lerPlanilhaDiario(buffer: ArrayBuffer) {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch { throw new DailyImportError("Não foi possível ler o arquivo. Envie a planilha .xlsx."); }
  const sheet = workbook.worksheets.find((item) => nameKey(item.name) === "IMPORTAR") ?? workbook.worksheets[0];
  if (!sheet) throw new DailyImportError("A planilha está vazia.");
  const cabecalho = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((valor) => String(cel(valor) ?? ""));
  const { indices, faltando } = mapearCabecalhoDiario(cabecalho);
  if (faltando.length) throw new DailyImportError(`Faltam colunas na aba "Importar": ${faltando.join(", ")}. Use "Baixar modelo".`);
  const linhas: LinhaDiario[] = [];
  for (let numero = 2; numero <= sheet.rowCount; numero++) {
    const valores = (sheet.getRow(numero).values as ExcelJS.CellValue[]).slice(1).map(cel);
    if (!valores.some((valor) => valor !== null && valor !== undefined && valor !== "")) continue;
    linhas.push(lerLinhaDiario(valores, indices, numero));
  }
  if (!linhas.length) throw new DailyImportError("Nenhuma linha para importar na aba \"Importar\".");
  if (linhas.length > 5000) throw new DailyImportError("Máximo de 5.000 linhas por planilha.");
  return linhas;
}

// ---------------------------------------------------------------------------
// Prévia
// ---------------------------------------------------------------------------
export type AjustesDiario = {
  // Grupo de equipamento (código, ou código#A / código#B quando o código tem duas escalas) → equipamento (null = não importar).
  equipamentos: Record<string, number | null>;
  // Linhas cujo "Problema relatado" vira Pendência (padrão: nenhuma).
  problemas: number[];
};

type Equip = { id: number; prefix: string; code: string; type: string; model: string; controlType: string; currentHours: number; currentKm: number; serviceFrontId: number | null; front: string | null; status: string };

export type GrupoEquipamento = {
  chave: string; codigo: string; escala: "A" | "B" | null; linhas: number; operadores: string[]; primeira: number; ultima: number; datas: [string, string];
  situacao: "OK" | "CASADO_PELO_PREFIXO" | "DECIDIR"; motivo: string | null; equipmentId: number | null; sugestaoId: number | null; escolhido: boolean;
};

export type LinhaPlano = {
  linha: number; data: string; equipmentId: number; prefixo: string; codigoPlanilha: string; unidade: "HOURS" | "KM"; frenteId: number; frente: string;
  operadorId: number | null; operadorNome: string | null; semOperador: boolean; local: string | null; localOriginal: string | null;
  inicial: number | null; final: number | null; trabalhado: number | null; producao: "PORTO" | "BALDEIO" | null;
  viagensPorto: number; volumePorto: number; torasPorto: number; viagensBaldeio: number; totalViagens: number;
  diesel: number | null; dieselPlanilha: number; dieselMovimentoId: number | null; dieselNota: string | null;
  problema: string | null; criarPendencia: boolean; observacoes: string | null; conferir: string | null; aviso: string | null;
};

export type PreviaDiario = Awaited<ReturnType<typeof montarPrevia>>;

async function carregarBase(db: Db, de: string, ate: string) {
  const [equipamentos, frentes, campo, existentes, combustivel, ultimaLeitura] = await Promise.all([
    db.select({ id: equipment.id, prefix: equipment.prefix, code: equipment.code, type: equipment.type, model: equipment.model, controlType: equipment.controlType,
      currentHours: equipment.currentHours, currentKm: equipment.currentKm, serviceFrontId: equipment.serviceFrontId, front: serviceFronts.name, status: equipment.status })
      .from(equipment).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId)).where(isNull(equipment.soldAt)),
    db.select({ id: serviceFronts.id, name: serviceFronts.name, active: serviceFronts.active }).from(serviceFronts),
    db.select({ id: users.id, name: users.name, status: users.status }).from(users).where(eq(users.role, "CAMPO")),
    db.select({ equipmentId: dailyRecords.equipmentId, date: dailyRecords.recordDate, start: dailyRecords.startReading, end: dailyRecords.endReading })
      .from(dailyRecords).where(and(gte(dailyRecords.recordDate, de), lte(dailyRecords.recordDate, ate))),
    db.select({ id: fuelMovements.id, equipmentId: fuelMovements.equipmentId, date: fuelMovements.movementDate, liters: fuelMovements.quantity })
      .from(fuelMovements).where(and(isNull(fuelMovements.deletedAt), eq(fuelMovements.movementType, "SAIDA"), eq(fuelMovements.balanceAdjustment, false), isNotNull(fuelMovements.equipmentId),
        gte(fuelMovements.movementDate, de), lte(fuelMovements.movementDate, ate))),
    db.select({ equipmentId: meterReadings.equipmentId, last: sql<string>`max(substr(${meterReadings.readingDate}, 1, 10))` }).from(meterReadings).groupBy(meterReadings.equipmentId),
  ]);
  return { equipamentos: equipamentos as Equip[], frentes, campo, existentes, combustivel, ultimaLeitura };
}

const atualDe = (item: Equip, unidade: "HOURS" | "KM") => (unidade === "KM" ? item.currentKm : item.currentHours);

export async function montarPrevia(db: Db, linhas: LinhaDiario[], ajustes: AjustesDiario) {
  const datasValidas = linhas.map((linha) => linha.data).filter((data): data is string => Boolean(data)).sort();
  const de = datasValidas[0] ?? "2000-01-01", ate = datasValidas.at(-1) ?? "2000-01-01";
  const base = await carregarBase(db, de, ate);
  const porCodigo = new Map<string, Equip[]>();
  for (const item of base.equipamentos) for (const chave of new Set([chaveEquipamento(item.prefix), chaveEquipamento(item.code)])) porCodigo.set(chave, [...(porCodigo.get(chave) ?? []), item]);

  // 1) Grupos de equipamento: código inteiro ou, quando há duas escalas de leitura, código#A/código#B.
  const codigos = [...new Set(linhas.map((linha) => linha.equipamento))].sort();
  const grupos: GrupoEquipamento[] = [];
  const linhasDoGrupo = new Map<string, LinhaDiario[]>();
  for (const codigo of codigos) {
    const doCodigo = linhas.filter((linha) => linha.equipamento === codigo);
    const escalas = gruposDeEscala(doCodigo);
    const partes: Array<[string, "A" | "B" | null, LinhaDiario[]]> = escalas
      ? [[`${codigo}#A`, "A", doCodigo.filter((linha) => escalas.baixo.linhas.includes(linha.linha))], [`${codigo}#B`, "B", doCodigo.filter((linha) => escalas.alto.linhas.includes(linha.linha))]]
      : [[codigo, null, doCodigo]];
    for (const [chave, escala, doGrupo] of partes) {
      const leituras = doGrupo.flatMap((linha) => [linha.leituraInicial, linha.leituraFinal]).filter((valor): valor is number => valor !== null && valor > 0);
      const datas = doGrupo.map((linha) => linha.data ?? "").sort();
      linhasDoGrupo.set(chave, doGrupo);
      grupos.push({ chave, codigo, escala, linhas: doGrupo.length, operadores: [...new Set(doGrupo.map((linha) => (linha.semOperador ? "(sem operador)" : linha.operador ?? "(sem operador)")))],
        primeira: leituras.length ? Math.min(...leituras) : 0, ultima: leituras.length ? Math.max(...leituras) : 0, datas: [datas[0], datas.at(-1)!],
        situacao: "OK", motivo: null, equipmentId: null, sugestaoId: null, escolhido: false });
    }
  }
  const confere = (item: Equip, grupo: GrupoEquipamento) => {
    const atual = atualDe(item, readingUnitFor(item.controlType, item.prefix));
    return atual <= 0 || grupo.ultima <= 0 || (grupo.ultima / atual < 20 && atual / grupo.ultima < 20);
  };
  for (const grupo of grupos) {
    const cadastro = porCodigo.get(grupo.codigo) ?? [];
    if (cadastro.length === 1 && confere(cadastro[0], grupo)) { grupo.equipmentId = cadastro[0].id; continue; }
    if (cadastro.length > 1) { grupo.situacao = "DECIDIR"; grupo.motivo = `Código ${grupo.codigo} em ${cadastro.length} cadastros`; continue; }
    if (cadastro.length === 1) { grupo.situacao = "DECIDIR"; grupo.motivo = `Leituras (${grupo.primeira.toLocaleString("pt-BR")} → ${grupo.ultima.toLocaleString("pt-BR")}) não batem com o ${cadastro[0].prefix} do cadastro (${atualDe(cadastro[0], readingUnitFor(cadastro[0].controlType, cadastro[0].prefix)).toLocaleString("pt-BR")})`; continue; }
    const pelo = casarPorPrefixo(grupo.codigo, base.equipamentos);
    if (pelo && confere(pelo, grupo)) { grupo.equipmentId = pelo.id; grupo.situacao = "CASADO_PELO_PREFIXO"; grupo.motivo = `Casado com ${pelo.prefix}`; continue; }
    grupo.situacao = "DECIDIR"; grupo.motivo = `Código ${grupo.codigo} não está no cadastro`;
  }
  // Sugestão para os que precisam de decisão: outro código da planilha com faixa de leituras contínua.
  const faixas = grupos.filter((grupo) => grupo.equipmentId && grupo.ultima > 0).map((grupo) => ({ equipmentId: grupo.equipmentId!, min: grupo.primeira, max: grupo.ultima }));
  const cadastroAtual = base.equipamentos.map((item) => ({ id: item.id, atual: atualDe(item, readingUnitFor(item.controlType, item.prefix)) }));
  for (const grupo of grupos.filter((item) => item.situacao === "DECIDIR")) grupo.sugestaoId = sugerirEquipamento(grupo, faixas.filter((faixa) => !(porCodigo.get(grupo.codigo) ?? []).some((item) => item.id === faixa.equipmentId)), cadastroAtual);
  // Decisões da pessoa (sobrepõem tudo, inclusive os automáticos).
  for (const grupo of grupos) {
    if (!(grupo.chave in ajustes.equipamentos)) continue;
    const escolha = ajustes.equipamentos[grupo.chave];
    grupo.escolhido = true;
    grupo.equipmentId = escolha && base.equipamentos.some((item) => item.id === escolha) ? escolha : null;
  }

  // 2) Linhas resolvidas, conferência de leituras por equipamento (grupos que viram o mesmo equipamento juntos).
  const equipPorId = new Map(base.equipamentos.map((item) => [item.id, item]));
  const resolvidas: Array<LinhaDiario & { equipmentId: number; chave: string }> = [];
  const naoImportadas: Array<{ linha: number; data: string | null; codigo: string; motivo: string }> = [];
  for (const grupo of grupos) for (const linha of linhasDoGrupo.get(grupo.chave)!) {
    if (!grupo.equipmentId) { naoImportadas.push({ linha: linha.linha, data: linha.data, codigo: linha.equipamento, motivo: grupo.situacao === "DECIDIR" && !grupo.escolhido ? "Equipamento a decidir" : "Equipamento não importado (decisão)" }); continue; }
    resolvidas.push({ ...linha, equipmentId: grupo.equipmentId, chave: grupo.chave });
  }
  const conferir = new Map<number, string>(); const avisos = new Map<number, string>();
  for (const id of new Set(resolvidas.map((linha) => linha.equipmentId))) {
    const r = conferirLeituras(resolvidas.filter((linha) => linha.equipmentId === id));
    for (const [linha, motivos] of r.conferir) conferir.set(linha, motivos.map((motivo) => MOTIVO_ROTULO[motivo]).join("; "));
    for (const [linha, motivos] of r.avisos) avisos.set(linha, motivos.map((motivo) => MOTIVO_ROTULO[motivo]).join("; "));
  }
  const frentePorNome = (nome: string) => base.frentes.find((frente) => frente.name.trim() === nome.trim()) ?? base.frentes.find((frente) => nameKey(frente.name) === nameKey(nome));
  const operadorPorChave = new Map(base.campo.map((item) => [nameKey(item.name), item]));
  const plano: LinhaPlano[] = []; const ignoradas: Array<{ linha: number; motivo: string }> = [];
  for (const linha of resolvidas) {
    const item = equipPorId.get(linha.equipmentId)!;
    const frente = frentePorNome(linha.frente);
    if (!linha.data) { ignoradas.push({ linha: linha.linha, motivo: "Data inválida" }); continue; }
    if (!frente) { ignoradas.push({ linha: linha.linha, motivo: `Frente "${linha.frente}" não encontrada` }); continue; }
    if (base.existentes.some((x) => x.equipmentId === linha.equipmentId && x.date === linha.data && x.start === linha.leituraInicial && x.end === linha.leituraFinal)) { ignoradas.push({ linha: linha.linha, motivo: "Já existe no sistema" }); continue; }
    const operador = !linha.semOperador && linha.operador ? operadorPorChave.get(nameKey(linha.operador)) ?? null : null;
    // Diesel: até 600 L fica como "informado pelo operador"; acima não é lançado — usa a saída de
    // diesel do Combustível do mesmo equipamento no mesmo dia, se houver.
    let diesel: number | null = linha.diesel > 0 ? linha.diesel : null; let movimento: number | null = null; let nota: string | null = null;
    if (linha.diesel > DIESEL_LIMITE_LITROS) {
      const saidas = base.combustivel.filter((x) => x.equipmentId === linha.equipmentId && x.date === linha.data);
      diesel = saidas.length ? saidas.reduce((total, x) => total + Number(x.liters), 0) : null; movimento = saidas[0]?.id ?? null;
      nota = saidas.length ? `Planilha informou ${linha.diesel.toLocaleString("pt-BR")} L (acima de ${DIESEL_LIMITE_LITROS} L, não lançado); usado o lançado no Combustível no dia` : `Planilha informou ${linha.diesel.toLocaleString("pt-BR")} L (acima de ${DIESEL_LIMITE_LITROS} L, não lançado); sem saída no Combustível no dia`;
    }
    const portTrips = linha.viagensPorto, baldeio = linha.viagensBaldeio;
    plano.push({
      linha: linha.linha, data: linha.data, equipmentId: item.id, prefixo: item.prefix, codigoPlanilha: linha.equipamento, unidade: readingUnitFor(item.controlType, item.prefix),
      frenteId: frente.id, frente: frente.name, operadorId: operador?.id ?? null, operadorNome: linha.semOperador ? null : operador?.name ?? linha.operador, semOperador: linha.semOperador || !linha.operador,
      local: linha.local, localOriginal: linha.localOriginal, inicial: linha.leituraInicial, final: linha.leituraFinal,
      trabalhado: linha.leituraInicial !== null && linha.leituraFinal !== null ? Math.round((linha.leituraFinal - linha.leituraInicial) * 100) / 100 : linha.trabalhado,
      producao: linha.localProducao ?? (portTrips > 0 ? "PORTO" : baldeio > 0 ? "BALDEIO" : null), viagensPorto: portTrips, volumePorto: linha.volumePorto, torasPorto: linha.torasPorto,
      viagensBaldeio: baldeio, totalViagens: linha.totalViagens, diesel, dieselPlanilha: linha.diesel, dieselMovimentoId: movimento, dieselNota: nota,
      problema: linha.problema, criarPendencia: Boolean(linha.problema && ajustes.problemas.includes(linha.linha)), observacoes: linha.observacoes,
      conferir: conferir.get(linha.linha) ?? null, aviso: avisos.get(linha.linha) ?? null,
    });
  }

  // 3) Leituras do equipamento: só a mais recente (por data) e maior que a atual, e sem leitura mais nova no histórico.
  const leituras = [...new Set(plano.map((linha) => linha.equipmentId))].map((id) => {
    const item = equipPorId.get(id)!; const validas = plano.filter((linha) => linha.equipmentId === id && !linha.conferir && linha.final !== null);
    const ultima = [...validas].sort((a, b) => b.data.localeCompare(a.data) || b.final! - a.final!)[0];
    const unidade = readingUnitFor(item.controlType, item.prefix); const atual = atualDe(item, unidade);
    const maisNova = base.ultimaLeitura.find((x) => x.equipmentId === id)?.last ?? null;
    const sobe = Boolean(ultima && ultima.final! > atual && (!maisNova || maisNova <= ultima.data));
    return { equipmentId: id, prefixo: item.prefix, unidade, atual, importada: ultima?.final ?? null, data: ultima?.data ?? null, sobe, historicoMaisNovo: maisNova && ultima && maisNova > ultima.data ? maisNova : null };
  });

  // 4) Operadores sem cadastro de campo (ficam com o nome; dá para vincular depois, um a um).
  const semCadastro = [...new Set(plano.filter((linha) => !linha.semOperador && !linha.operadorId && linha.operadorNome).map((linha) => linha.operadorNome!))].sort().map((nome) => ({
    nome, lancamentos: plano.filter((linha) => linha.operadorNome === nome).length,
    parecidos: base.campo.map((item) => ({ id: item.id, nome: item.name, s: semelhanca(nome, item.name) })).filter((item) => item.s).slice(0, 3).map((item) => ({ id: item.id, nome: item.nome, semelhanca: SEMELHANCA_ROTULO[item.s!] })),
  }));

  const totaisPlanilha = totaisDiario(linhas);
  const soma = (campo: keyof LinhaPlano) => plano.reduce((total, linha) => total + (typeof linha[campo] === "number" ? linha[campo] as number : 0), 0);
  const porFrente = Object.entries(plano.reduce<Record<string, number>>((acc, linha) => { acc[linha.frente] = (acc[linha.frente] ?? 0) + 1; return acc; }, {})).map(([nome, total]) => ({ nome, total }));
  return {
    label: mesDoLote(datasValidas), periodo: { de, ate }, grupos, plano, ignoradas, naoImportadas, leituras, semCadastro,
    equipamentosCadastro: base.equipamentos.map((item) => ({ id: item.id, prefix: item.prefix, model: `${item.type} ${item.model}`.trim(), front: item.front, atual: atualDe(item, readingUnitFor(item.controlType, item.prefix)), unidade: readingUnitFor(item.controlType, item.prefix) }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix, "pt-BR", { numeric: true })),
    resumo: {
      planilha: totaisPlanilha, importar: plano.length, conferir: plano.filter((linha) => linha.conferir).length, avisos: plano.filter((linha) => linha.aviso).length,
      ignoradas: ignoradas.length, naoImportadas: naoImportadas.length, decidir: grupos.filter((grupo) => grupo.situacao === "DECIDIR" && !grupo.escolhido).length,
      viagens: soma("totalViagens"), volumePorto: Math.round(soma("volumePorto") * 100) / 100, dieselInformado: soma("diesel"), dieselNaoLancado: plano.filter((linha) => linha.dieselNota).length,
      semOperador: plano.filter((linha) => linha.semOperador).length, operadoresVinculados: new Set(plano.filter((linha) => linha.operadorId).map((linha) => linha.operadorId)).size,
      operadoresSemCadastro: semCadastro.length, problemas: plano.filter((linha) => linha.problema).length, pendencias: plano.filter((linha) => linha.criarPendencia).length,
      leiturasQueSobem: leituras.filter((item) => item.sobe).length, porFrente,
    },
  };
}

export async function previaDiario(user: SessionUser, buffer: ArrayBuffer, ajustes: AjustesDiario) {
  exigeAdmin(user);
  return montarPrevia(await getDb(), await lerPlanilhaDiario(buffer), ajustes);
}

// ---------------------------------------------------------------------------
// Confirmar: lote + blocos de até 500, finalizar e desfazer
// ---------------------------------------------------------------------------
async function quemRegistra(db: Db, user: SessionUser) {
  const mathews = (await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = 'mathews' OR lower(${users.email}) LIKE 'mathews%'`).limit(1))[0];
  return mathews?.id ?? user.id;
}

export async function iniciarImportacao(user: SessionUser, buffer: ArrayBuffer, fileName: string, ajustes: AjustesDiario) {
  exigeAdmin(user);
  const db = await getDb();
  const previa = await montarPrevia(db, await lerPlanilhaDiario(buffer), ajustes);
  if (previa.resumo.decidir) throw new DailyImportError(`Decida o equipamento de ${previa.resumo.decidir} grupo(s) antes de confirmar.`);
  if (!previa.plano.length) throw new DailyImportError("Nada para importar.");
  const andamento = (await db.select({ id: dailyImportBatches.id }).from(dailyImportBatches).where(eq(dailyImportBatches.status, "EM_ANDAMENTO")).limit(1))[0];
  if (andamento) throw new DailyImportError(`Há uma importação em andamento (lote ${andamento.id}). Continue ou desfaça antes de começar outra.`, 409);
  const registradoPor = await quemRegistra(db, user);
  const [lote] = await db.insert(dailyImportBatches).values({
    label: previa.label, fileName: fileName.slice(0, 200), importedBy: user.id, registeredBy: registradoPor, totalRows: previa.resumo.planilha.linhas,
    skippedRows: previa.ignoradas.length + previa.naoImportadas.length, reviewRows: previa.resumo.conferir,
    plan: JSON.stringify({ linhas: previa.plano, leituras: previa.leituras, ignoradas: previa.ignoradas, naoImportadas: previa.naoImportadas }),
  }).returning({ id: dailyImportBatches.id });
  await db.insert(auditLogs).values({ userId: user.id, entityType: "DAILY_IMPORT", entityId: String(lote.id), action: "IMPORTAÇÃO DO CONTROLE DIÁRIO INICIADA", newValue: JSON.stringify({ arquivo: fileName, linhas: previa.plano.length, label: previa.label }), occurredAt: new Date().toISOString() });
  return { loteId: lote.id, total: previa.plano.length, blocos: Math.ceil(previa.plano.length / BLOCO), label: previa.label };
}

type Plano = { linhas: LinhaPlano[]; leituras: PreviaDiario["leituras"]; ignoradas: PreviaDiario["ignoradas"]; naoImportadas: PreviaDiario["naoImportadas"] };
async function lote(db: Db, id: number) {
  const row = (await db.select().from(dailyImportBatches).where(eq(dailyImportBatches.id, id)).limit(1))[0];
  if (!row) throw new DailyImportError("Lote não encontrado.", 404);
  return { ...row, plano: JSON.parse(row.plan ?? "{}") as Plano };
}

export async function importarBloco(user: SessionUser, loteId: number, bloco: number) {
  exigeAdmin(user);
  const db = await getDb();
  const atual = await lote(db, loteId);
  if (atual.status !== "EM_ANDAMENTO") throw new DailyImportError("Este lote não está em andamento.", 409);
  const fatia = atual.plano.linhas.slice(bloco * BLOCO, (bloco + 1) * BLOCO);
  if (!fatia.length) return { inseridos: 0, bloco };
  const agora = new Date().toISOString();
  const inseridos = await db.transaction(async (tx) => {
    // Repetir o bloco (resposta perdida) não duplica: pula as linhas já gravadas neste lote.
    const ja = new Set((await tx.select({ row: dailyRecords.sourceRow }).from(dailyRecords).where(and(eq(dailyRecords.importBatchId, loteId), inArray(dailyRecords.sourceRow, fatia.map((linha) => linha.linha))))).map((row) => row.row));
    const novas = fatia.filter((linha) => !ja.has(linha.linha));
    if (!novas.length) return 0;
    const criados = await tx.insert(dailyRecords).values(novas.map((linha) => ({
      equipmentId: linha.equipmentId, userId: atual.registeredBy, recordDate: linha.data, workedToday: linha.inicial !== null || linha.final !== null, noWorkReason: null,
      serviceFrontId: linha.frenteId, location: linha.local, locationOriginal: linha.localOriginal, readingUnit: linha.unidade, startReading: linha.inicial, endReading: linha.final,
      inactiveOrProblem: Boolean(linha.problema), problemReason: linha.problema, hadProduction: Boolean(linha.producao) || linha.totalViagens > 0, productionType: linha.producao,
      notes: linha.observacoes, officialServiceFrontId: null, operatorName: linha.semOperador ? null : linha.operadorNome, manualEntry: true, fieldOperatorId: linha.operadorId, noOperator: linha.semOperador,
      portTrips: linha.viagensPorto || null, portVolumeM3: linha.volumePorto || null, portLogs: linha.torasPorto || null, baldeioTrips: linha.viagensBaldeio || null, totalTrips: linha.totalViagens || null,
      reportedDieselLiters: linha.diesel, dieselFuelMovementId: linha.dieselMovimentoId, dieselNote: linha.dieselNota,
      reviewStatus: linha.conferir ? "CONFERIR" as const : "OK" as const, reviewReason: linha.conferir, origin: atual.label, importBatchId: loteId, sourceRow: linha.linha, createdAt: agora, updatedAt: agora,
    }))).returning({ id: dailyRecords.id, sourceRow: dailyRecords.sourceRow });
    const idPorLinha = new Map(criados.map((row) => [row.sourceRow!, row.id]));
    // A frente oficial do equipamento no dia (mesma regra do registro pelo app).
    await tx.execute(sql`UPDATE daily_records d SET official_service_front_id = e.service_front_id FROM equipment e WHERE e.id = d.equipment_id AND d.import_batch_id = ${loteId} AND d.official_service_front_id IS NULL`);
    // Leitura final no histórico de leituras (CONTROLE_DIARIO), só das linhas sem "Conferir".
    const leituras = novas.filter((linha) => !linha.conferir && linha.final !== null);
    if (leituras.length) await tx.insert(meterReadings).values(leituras.map((linha) => ({
      equipmentId: linha.equipmentId, readingDate: linha.data, hours: linha.unidade === "HOURS" ? linha.final : null, km: linha.unidade === "KM" ? linha.final : null,
      operator: linha.operadorNome ?? "Sem operador", serviceFrontId: linha.frenteId, notes: `Controle Diário importado (${atual.label}, linha ${linha.linha})`, source: "CONTROLE_DIARIO" as const,
      createdBy: atual.registeredBy, dailyRecordId: idPorLinha.get(linha.linha) ?? null, dailyImportBatchId: loteId, createdAt: agora, updatedAt: agora,
    })));
    const pendencias = novas.filter((linha) => linha.criarPendencia && linha.problema);
    if (pendencias.length) await tx.insert(dailyProblemReports).values(pendencias.map((linha) => ({
      dailyRecordId: idPorLinha.get(linha.linha) ?? null, equipmentId: linha.equipmentId, serviceFrontId: linha.frenteId, recordDate: linha.data, operatorName: linha.operadorNome,
      description: linha.problema!, importBatchId: loteId, createdBy: user.id, createdAt: agora, updatedAt: agora,
    })));
    await tx.update(dailyImportBatches).set({ importedRows: sql`${dailyImportBatches.importedRows} + ${novas.length}`, updatedAt: agora }).where(eq(dailyImportBatches.id, loteId));
    return novas.length;
  });
  return { inseridos, bloco };
}

// Muda a leitura atual (só a unidade do Controle Diário), registra auditoria e refaz os alertas,
// como uma leitura lançada à mão; depois recalcula os ciclos de troca de óleo.
async function aplicarLeitura(equipmentId: number, unidade: "HOURS" | "KM", valor: number, actor: { id: number }, motivo: string) {
  const d1 = await getD1();
  const core = await loadEquipmentCore(d1, equipmentId);
  if (!core) return;
  const agora = new Date().toISOString();
  const atualizado = { ...core, current_hours: unidade === "HOURS" ? valor : core.current_hours, current_km: unidade === "KM" ? valor : core.current_km };
  const [plans, thresholds] = await Promise.all([loadPlansForEquipment(d1, equipmentId), loadThresholds(d1)]);
  await d1.batch([
    d1.prepare(`UPDATE equipment SET current_hours=?,current_km=?,updated_at=? WHERE id=?`).bind(atualizado.current_hours, atualizado.current_km, agora, equipmentId),
    d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(actor.id, "EQUIPMENT", String(equipmentId), motivo, JSON.stringify({ hours: core.current_hours, km: core.current_km }), JSON.stringify({ hours: atualizado.current_hours, km: atualizado.current_km, source: "CONTROLE_DIARIO" }), agora),
    ...buildAlertStatements(d1, atualizado, plans, thresholds, agora),
  ]);
  await recalculateMaintenanceCycles(d1, { equipmentId, force: true });
}

export async function finalizarImportacao(user: SessionUser, loteId: number) {
  exigeAdmin(user);
  const db = await getDb();
  const atual = await lote(db, loteId);
  if (atual.status !== "EM_ANDAMENTO") throw new DailyImportError("Este lote não está em andamento.", 409);
  if (atual.importedRows < atual.plano.linhas.length) throw new DailyImportError(`Faltam ${atual.plano.linhas.length - atual.importedRows} linha(s) para gravar antes de finalizar.`, 409);
  const alteradas: Array<{ equipmentId: number; prefixo: string; unidade: "HOURS" | "KM"; antes: number; depois: number }> = [];
  for (const item of atual.plano.leituras) {
    if (!item.sobe || item.importada === null) continue;
    // Confere de novo na hora de gravar: alguém pode ter lançado leitura maior enquanto importava.
    const agoraEquip = (await db.select({ hours: equipment.currentHours, km: equipment.currentKm }).from(equipment).where(eq(equipment.id, item.equipmentId)).limit(1))[0];
    const antes = item.unidade === "KM" ? agoraEquip.km : agoraEquip.hours;
    if (item.importada <= antes) continue;
    await aplicarLeitura(item.equipmentId, item.unidade, item.importada, user, `LEITURA ATUALIZADA PELA IMPORTAÇÃO DO CONTROLE DIÁRIO (${atual.label})`);
    alteradas.push({ equipmentId: item.equipmentId, prefixo: item.prefixo, unidade: item.unidade, antes, depois: item.importada });
  }
  // Os demais equipamentos do lote também recalculam (o histórico de leituras mudou).
  const d1 = await getD1();
  for (const id of new Set(atual.plano.linhas.map((linha) => linha.equipmentId))) if (!alteradas.some((item) => item.equipmentId === id)) await recalculateMaintenanceCycles(d1, { equipmentId: id, force: true });
  const agora = new Date().toISOString();
  const resumo = { leiturasAtualizadas: alteradas, registros: atual.importedRows, conferir: atual.reviewRows };
  await db.update(dailyImportBatches).set({ status: "CONCLUIDO", finishedAt: agora, summary: JSON.stringify(resumo), updatedAt: agora }).where(eq(dailyImportBatches.id, loteId));
  await db.insert(auditLogs).values({ userId: user.id, entityType: "DAILY_IMPORT", entityId: String(loteId), action: "IMPORTAÇÃO DO CONTROLE DIÁRIO CONCLUÍDA", newValue: JSON.stringify(resumo), occurredAt: agora });
  return resumo;
}

export async function desfazerImportacao(user: SessionUser, loteId: number) {
  exigeAdmin(user);
  const db = await getDb();
  const atual = await lote(db, loteId);
  if (atual.status === "DESFEITO") throw new DailyImportError("Este lote já foi desfeito.", 409);
  const resumo = JSON.parse(atual.summary ?? "{}") as { leiturasAtualizadas?: Array<{ equipmentId: number; unidade: "HOURS" | "KM"; antes: number; depois: number }> };
  const devolvidas: string[] = [];
  await db.transaction(async (tx) => {
    await tx.delete(dailyProblemReports).where(eq(dailyProblemReports.importBatchId, loteId));
    await tx.delete(meterReadings).where(eq(meterReadings.dailyImportBatchId, loteId));
    await tx.delete(dailyRecords).where(eq(dailyRecords.importBatchId, loteId));
  });
  // Devolve a leitura atual só se ainda for a que a importação colocou (ninguém lançou maior depois).
  for (const item of resumo.leiturasAtualizadas ?? []) {
    const agoraEquip = (await db.select({ hours: equipment.currentHours, km: equipment.currentKm, prefix: equipment.prefix }).from(equipment).where(eq(equipment.id, item.equipmentId)).limit(1))[0];
    const valor = item.unidade === "KM" ? agoraEquip.km : agoraEquip.hours;
    if (valor !== item.depois) continue;
    await aplicarLeitura(item.equipmentId, item.unidade, item.antes, user, `LEITURA DEVOLVIDA AO DESFAZER A IMPORTAÇÃO DO CONTROLE DIÁRIO (lote ${loteId})`);
    devolvidas.push(agoraEquip.prefix);
  }
  const agora = new Date().toISOString();
  await db.update(dailyImportBatches).set({ status: "DESFEITO", undoneAt: agora, undoneBy: user.id, updatedAt: agora }).where(eq(dailyImportBatches.id, loteId));
  await db.insert(auditLogs).values({ userId: user.id, entityType: "DAILY_IMPORT", entityId: String(loteId), action: "IMPORTAÇÃO DO CONTROLE DIÁRIO DESFEITA", newValue: JSON.stringify({ devolvidas }), occurredAt: agora });
  return { devolvidas };
}

export async function listarLotes() {
  const db = await getDb();
  const rows = await db.select({ id: dailyImportBatches.id, label: dailyImportBatches.label, fileName: dailyImportBatches.fileName, status: dailyImportBatches.status, totalRows: dailyImportBatches.totalRows,
    importedRows: dailyImportBatches.importedRows, skippedRows: dailyImportBatches.skippedRows, reviewRows: dailyImportBatches.reviewRows, createdAt: dailyImportBatches.createdAt, finishedAt: dailyImportBatches.finishedAt,
    undoneAt: dailyImportBatches.undoneAt, importedBy: users.name, planSize: sql<number>`coalesce(json_array_length((${dailyImportBatches.plan})::json -> 'linhas'), 0)` })
    .from(dailyImportBatches).innerJoin(users, eq(users.id, dailyImportBatches.importedBy)).orderBy(sql`${dailyImportBatches.id} desc`).limit(30);
  return rows.map((row) => ({ ...row, planSize: Number(row.planSize), blocos: Math.ceil(Number(row.planSize) / BLOCO) }));
}

// Modelo vazio com as mesmas colunas (para os próximos meses).
export async function modeloPlanilha() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Importar");
  sheet.columns = ["Data", "Equipamento", "Frente", "Operador", "Sem operador", "Local", "Local original", "Leitura inicial", "Leitura final", "KM/Horas trabalhadas", "Local Produção",
    "Viagens Porto", "Volume Porto (m³)", "Toras Porto", "Viagens Baldeio", "Total de viagens", "Diesel (L)", "Problema relatado", "Observações"].map((header) => ({ header, width: Math.max(12, header.length + 2) }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(["2026-10-01", "CM-03", "Arapiuns", "NOME DO OPERADOR", "NÃO", "FAZENDA ESPERANÇA", "Esperança", 339540, 339593, 53, "Baldeio", 0, 0, 0, 5, 5, 0, "", ""]);
  const ajuda = workbook.addWorksheet("Como preencher");
  [["Data", "AAAA-MM-DD ou DD/MM/AAAA"], ["Equipamento", "Prefixo do cadastro (ex.: CM-03, HL-02)"], ["Frente", "Nome da frente (Arapiuns, Mamuru, Flexal)"],
    ["Operador", "Nome como está em Funcionários de campo; vazio + Sem operador = SIM quando não houver"], ["Local / Local original", "Local padronizado e o texto como foi escrito"],
    ["Leituras", "KM ou horímetro inicial e final do dia (iguais = não rodou)"], ["Produção", "Porto (viagens, volume m³, toras) ou Baldeio (viagens)"],
    ["Diesel (L)", `Diesel informado pelo operador — não vira saída de combustível; acima de ${DIESEL_LIMITE_LITROS} L não é lançado`], ["Problema relatado", "Na prévia dá para transformar em Pendência"]]
    .forEach((linha) => ajuda.addRow(linha));
  ajuda.getColumn(1).width = 22; ajuda.getColumn(2).width = 90;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Correção de um registro importado (Histórico → "Corrigir"): operador (vincular ao cadastro de
// campo, digitar o nome ou "sem operador"; opcionalmente para todos os registros com o mesmo nome),
// leituras e status. Leitura final sem "Conferir" entra no histórico de leituras do equipamento.
// ---------------------------------------------------------------------------
export type CorrecaoImportado = {
  operador: { tipo: "CAMPO"; id: number } | { tipo: "NOME"; nome: string } | { tipo: "SEM" } | null;
  aplicarMesmoNome: boolean; inicial: number | null; final: number | null; conferir: boolean;
};

export async function corrigirImportado(user: SessionUser, recordId: number, input: CorrecaoImportado) {
  if (!user.permissions.includes("daily.manage")) throw new DailyImportError("Você não possui permissão para corrigir registros.", 403);
  const db = await getDb();
  const registro = (await db.select().from(dailyRecords).where(eq(dailyRecords.id, recordId)).limit(1))[0];
  if (!registro) throw new DailyImportError("Registro não encontrado.", 404);
  if (input.inicial !== null && input.final !== null && input.final < input.inicial && !input.conferir) throw new DailyImportError("A leitura final é menor que a inicial: marque “Conferir” ou corrija.");
  let operador: { fieldOperatorId: number | null; operatorName: string | null; noOperator: boolean } | null = null;
  if (input.operador?.tipo === "CAMPO") {
    const campo = (await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, input.operador.id), eq(users.role, "CAMPO"))).limit(1))[0];
    if (!campo) throw new DailyImportError("Funcionário de campo não encontrado.");
    operador = { fieldOperatorId: campo.id, operatorName: campo.name, noOperator: false };
  } else if (input.operador?.tipo === "NOME") {
    const nome = input.operador.nome.trim().replace(/\s+/g, " ").toUpperCase();
    if (nome.length < 3) throw new DailyImportError("Informe o nome do operador.");
    operador = { fieldOperatorId: null, operatorName: nome, noOperator: false };
  } else if (input.operador?.tipo === "SEM") operador = { fieldOperatorId: null, operatorName: null, noOperator: true };
  const agora = new Date().toISOString();
  let outros = 0;
  await db.transaction(async (tx) => {
    await tx.update(dailyRecords).set({
      ...(operador ?? {}), startReading: input.inicial, endReading: input.final, reviewStatus: input.conferir ? "CONFERIR" : "OK",
      reviewReason: input.conferir ? registro.reviewReason ?? "Marcado para conferir" : null, updatedAt: agora,
    }).where(eq(dailyRecords.id, recordId));
    // Mesmo nome sem vínculo em outros registros (opcional): vincula todos de uma vez.
    if (operador && input.aplicarMesmoNome && registro.operatorName && !registro.fieldOperatorId) {
      const mesmos = await tx.update(dailyRecords).set({ ...operador, updatedAt: agora })
        .where(and(sql`lower(${dailyRecords.operatorName}) = lower(${registro.operatorName})`, isNull(dailyRecords.fieldOperatorId), sql`${dailyRecords.id} <> ${recordId}`))
        .returning({ id: dailyRecords.id });
      outros = mesmos.length;
    }
    await tx.delete(meterReadings).where(eq(meterReadings.dailyRecordId, recordId));
    if (!input.conferir && input.final !== null) await tx.insert(meterReadings).values({
      equipmentId: registro.equipmentId, readingDate: registro.recordDate, hours: registro.readingUnit === "HOURS" ? input.final : null, km: registro.readingUnit === "KM" ? input.final : null,
      operator: operador?.operatorName ?? registro.operatorName ?? "Sem operador", serviceFrontId: registro.serviceFrontId, notes: `Controle Diário corrigido (registro ${recordId})`,
      source: "CONTROLE_DIARIO", createdBy: user.id, dailyRecordId: recordId, dailyImportBatchId: registro.importBatchId, createdAt: agora, updatedAt: agora,
    });
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "DAILY_RECORD", entityId: String(recordId), action: "CONTROLE DIÁRIO CORRIGIDO",
      previousValue: JSON.stringify({ operatorName: registro.operatorName, fieldOperatorId: registro.fieldOperatorId, start: registro.startReading, end: registro.endReading, review: registro.reviewStatus }),
      newValue: JSON.stringify({ ...operador, start: input.inicial, end: input.final, review: input.conferir ? "CONFERIR" : "OK", outros }), occurredAt: agora });
  });
  // Saiu do "Conferir" com leitura final válida: sobe a leitura atual se for a mais recente e maior.
  let leituraAtualizada = false;
  if (!input.conferir && input.final !== null) {
    const unidade = registro.readingUnit === "KM" ? "KM" : "HOURS";
    const atual = (await db.select({ hours: equipment.currentHours, km: equipment.currentKm }).from(equipment).where(eq(equipment.id, registro.equipmentId)).limit(1))[0];
    const [maisNova] = await db.select({ dia: sql<string | null>`max(${meterReadings.readingDate})` }).from(meterReadings).where(eq(meterReadings.equipmentId, registro.equipmentId));
    const antes = unidade === "KM" ? atual?.km ?? 0 : atual?.hours ?? 0;
    if (atual && input.final > antes && (!maisNova?.dia || String(maisNova.dia).slice(0, 10) <= registro.recordDate)) {
      await aplicarLeitura(registro.equipmentId, unidade, input.final, user, `LEITURA ATUALIZADA PELA CORREÇÃO DO CONTROLE DIÁRIO (registro ${recordId})`);
      leituraAtualizada = true;
    }
  }
  return { outros, leituraAtualizada };
}

export async function opcoesOperadores() {
  const db = await getDb();
  return db.select({ id: users.id, name: users.name, active: sql<boolean>`${users.status} = 'ACTIVE'` }).from(users).where(eq(users.role, "CAMPO")).orderBy(users.name);
}
