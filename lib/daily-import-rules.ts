// ---------------------------------------------------------------------------
// Importação do Controle Diário (planilha "Importar"): leitura das linhas e conferências puras
// (sequência de leituras, mais de um registro no mesmo dia, código de equipamento usado por dois
// equipamentos). Testadas em tests/daily-import-rules.test.mjs.
// Colunas: Data | Equipamento | Frente | Operador | Sem operador | Local | Local original |
// Leitura inicial | Leitura final | KM/Horas trabalhadas | Local Produção | Viagens Porto |
// Volume Porto (m³) | Toras Porto | Viagens Baldeio | Total de viagens | Diesel (L) |
// Problema relatado | Observações
// ---------------------------------------------------------------------------
import { nameKey } from "./employee-rules";

export { nameKey };

export type ColunaDiario = "data" | "equipamento" | "frente" | "operador" | "semOperador" | "local" | "localOriginal" | "leituraInicial" | "leituraFinal" | "trabalhado"
  | "localProducao" | "viagensPorto" | "volumePorto" | "torasPorto" | "viagensBaldeio" | "totalViagens" | "diesel" | "problema" | "observacoes";

export const COLUNAS_DIARIO: Array<[ColunaDiario, string, RegExp]> = [
  ["data", "Data", /^data$/], ["equipamento", "Equipamento", /^equipamento$/], ["frente", "Frente", /^frente$/], ["operador", "Operador", /^operador$/],
  ["semOperador", "Sem operador", /^sem operador/], ["localOriginal", "Local original", /^local original$/], ["localProducao", "Local Produção", /^local (de )?producao$/],
  ["local", "Local", /^local$/], ["leituraInicial", "Leitura inicial", /^leitura inicial$/], ["leituraFinal", "Leitura final", /^leitura final$/],
  ["trabalhado", "KM/Horas trabalhadas", /trabalhad/], ["viagensPorto", "Viagens Porto", /^viagens porto$/], ["volumePorto", "Volume Porto (m³)", /^volume porto/],
  ["torasPorto", "Toras Porto", /^toras porto$/], ["viagensBaldeio", "Viagens Baldeio", /^viagens baldeio$/], ["totalViagens", "Total de viagens", /^total de viagens$/],
  ["diesel", "Diesel (L)", /^diesel/], ["problema", "Problema relatado", /^problema/], ["observacoes", "Observações", /^observac/],
];

export function mapearCabecalhoDiario(cabecalho: string[]) {
  const indices: Partial<Record<ColunaDiario, number>> = {};
  cabecalho.forEach((titulo, index) => {
    const chave = nameKey(titulo ?? "").toLowerCase();
    const achado = COLUNAS_DIARIO.find(([coluna, , padrao]) => indices[coluna] === undefined && padrao.test(chave));
    if (achado) indices[achado[0]] = index;
  });
  const obrigatorias: ColunaDiario[] = ["data", "equipamento", "frente", "leituraInicial", "leituraFinal"];
  return { indices, faltando: obrigatorias.filter((coluna) => indices[coluna] === undefined).map((coluna) => COLUNAS_DIARIO.find(([c]) => c === coluna)![1]) };
}

// Números: 1.234,5 / 1234.5 / 1234 → número; vazio → null.
export function lerNumero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  const texto = String(valor).trim().replace(/\s/g, "");
  if (!texto) return null;
  const normal = texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto;
  const numero = Number(normal);
  return Number.isFinite(numero) ? numero : null;
}

// Datas: 2026-09-01, 01/09/2026, objeto Date ou número de série do Excel.
export function lerData(valor: unknown): string | null {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.toISOString().slice(0, 10);
  if (typeof valor === "number" && valor > 20000 && valor < 80000) return new Date(Math.round((valor - 25569) * 86_400_000)).toISOString().slice(0, 10);
  const texto = String(valor ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texto);
  return br ? `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}` : null;
}

export const chaveEquipamento = (codigo: string) => codigo.toUpperCase().replace(/\s+/g, "").replace(/[–—_]/g, "-");

export type LinhaDiario = {
  linha: number; data: string | null; equipamento: string; frente: string; operador: string | null; semOperador: boolean; local: string | null; localOriginal: string | null;
  leituraInicial: number | null; leituraFinal: number | null; trabalhado: number | null; localProducao: "PORTO" | "BALDEIO" | null;
  viagensPorto: number; volumePorto: number; torasPorto: number; viagensBaldeio: number; totalViagens: number; diesel: number; problema: string | null; observacoes: string | null;
};

const texto = (valor: unknown) => { const t = String(valor ?? "").replace(/\s+/g, " ").trim(); return t || null; };

export function lerLinhaDiario(valores: unknown[], indices: Partial<Record<ColunaDiario, number>>, linha: number): LinhaDiario {
  const pega = (coluna: ColunaDiario) => (indices[coluna] === undefined ? null : valores[indices[coluna]!]);
  const n = (coluna: ColunaDiario) => lerNumero(pega(coluna)) ?? 0;
  const producao = nameKey(String(pega("localProducao") ?? ""));
  const viagensPorto = n("viagensPorto"), viagensBaldeio = n("viagensBaldeio");
  return {
    linha, data: lerData(pega("data")), equipamento: chaveEquipamento(String(pega("equipamento") ?? "")), frente: texto(pega("frente")) ?? "",
    operador: texto(pega("operador"))?.toUpperCase() ?? null, semOperador: /^SIM|^S$/.test(nameKey(String(pega("semOperador") ?? ""))),
    local: texto(pega("local"))?.toUpperCase() ?? null, localOriginal: texto(pega("localOriginal")),
    leituraInicial: lerNumero(pega("leituraInicial")), leituraFinal: lerNumero(pega("leituraFinal")), trabalhado: lerNumero(pega("trabalhado")),
    localProducao: producao.startsWith("PORTO") ? "PORTO" : producao.startsWith("BALDEIO") ? "BALDEIO" : null,
    viagensPorto, volumePorto: n("volumePorto"), torasPorto: n("torasPorto"), viagensBaldeio,
    totalViagens: lerNumero(pega("totalViagens")) ?? viagensPorto + viagensBaldeio, diesel: n("diesel"), problema: texto(pega("problema")), observacoes: texto(pega("observacoes")),
  };
}

// ---------------------------------------------------------------------------
// Conferências
// ---------------------------------------------------------------------------
export type MotivoConferir = "FINAL_MENOR_QUE_INICIAL" | "INICIAL_MENOR_QUE_FINAL_ANTERIOR" | "SEM_LEITURA";
// Leituras iguais (0 trabalhado, inicial = final do dia anterior) são normais: o equipamento pode não
// ter rodado. Só um registro idêntico a outro do mesmo dia (com trabalho) é sinalizado.
export type AvisoDia = "LEITURAS_IGUAIS_NO_DIA";
export const MOTIVO_ROTULO: Record<MotivoConferir | AvisoDia, string> = {
  FINAL_MENOR_QUE_INICIAL: "Leitura final menor que a inicial", INICIAL_MENOR_QUE_FINAL_ANTERIOR: "Inicial menor que a final do dia anterior", SEM_LEITURA: "Sem leitura inicial/final",
  LEITURAS_IGUAIS_NO_DIA: "Mesmas leituras de outro registro do dia",
};

type ComLeitura = Pick<LinhaDiario, "linha" | "data" | "leituraInicial" | "leituraFinal">;

// Por equipamento (já separado: o CC-02 dividido em dois vira duas chaves), em ordem de data:
// final < inicial, ou inicial menor que a maior final de um dia anterior → "Conferir".
// Mais de um registro no mesmo dia: entram separados; só sinaliza o idêntico a outro do dia.
export function conferirLeituras<T extends ComLeitura>(linhas: T[]) {
  const conferir = new Map<number, MotivoConferir[]>();
  const avisos = new Map<number, AvisoDia[]>();
  const add = <K,>(mapa: Map<number, K[]>, linha: number, motivo: K) => mapa.set(linha, [...(mapa.get(linha) ?? []), motivo]);
  const ordenadas = [...linhas].sort((a, b) => (a.data ?? "").localeCompare(b.data ?? "") || (a.leituraInicial ?? 0) - (b.leituraInicial ?? 0) || a.linha - b.linha);
  let maiorFinalAnterior: number | null = null;
  let diaAtual: string | null = null;
  let maiorFinalDoDia: number | null = null;
  for (const item of ordenadas) {
    if (item.data !== diaAtual) {
      if (maiorFinalDoDia !== null) maiorFinalAnterior = Math.max(maiorFinalAnterior ?? -Infinity, maiorFinalDoDia);
      diaAtual = item.data; maiorFinalDoDia = null;
    }
    if (item.leituraInicial === null || item.leituraFinal === null) { add(conferir, item.linha, "SEM_LEITURA"); continue; }
    if (item.leituraFinal < item.leituraInicial) add(conferir, item.linha, "FINAL_MENOR_QUE_INICIAL");
    if (maiorFinalAnterior !== null && item.leituraInicial < maiorFinalAnterior) add(conferir, item.linha, "INICIAL_MENOR_QUE_FINAL_ANTERIOR");
    // Só leituras válidas formam a referência do dia seguinte.
    if (!conferir.has(item.linha)) maiorFinalDoDia = Math.max(maiorFinalDoDia ?? -Infinity, item.leituraFinal);
  }
  const porDia = new Map<string, T[]>();
  for (const item of linhas) porDia.set(item.data ?? "", [...(porDia.get(item.data ?? "") ?? []), item]);
  for (const doDia of porDia.values()) {
    if (doDia.length < 2) continue;
    for (const item of doDia) {
      if (item.leituraInicial === null || item.leituraFinal === null || item.leituraFinal === item.leituraInicial) continue;
      if (doDia.some((outro) => outro.linha !== item.linha && outro.leituraInicial === item.leituraInicial && outro.leituraFinal === item.leituraFinal)) add(avisos, item.linha, "LEITURAS_IGUAIS_NO_DIA");
    }
  }
  return { conferir, avisos };
}

// Um código com leituras em escalas muito diferentes (ex.: CC-02 com ~168.000 km e ~500 h) é de dois
// equipamentos: agrupa por operador e separa as escalas (fator > 20 entre as medianas).
export function gruposDeEscala<T extends ComLeitura & { operador: string | null }>(linhas: T[]) {
  const comLeitura = linhas.filter((item) => item.leituraFinal !== null && item.leituraFinal > 0);
  if (comLeitura.length < 2) return null;
  const valores = comLeitura.map((item) => item.leituraFinal!).sort((a, b) => a - b);
  let corte = -1; let maiorSalto = 1;
  for (let index = 1; index < valores.length; index++) { const salto = valores[index] / Math.max(1, valores[index - 1]); if (salto > maiorSalto) { maiorSalto = salto; corte = valores[index]; } }
  if (maiorSalto < 20) return null;
  const baixo = linhas.filter((item) => (item.leituraFinal ?? 0) < corte);
  const alto = linhas.filter((item) => (item.leituraFinal ?? 0) >= corte);
  const resumo = (grupo: T[]) => ({
    linhas: grupo.map((item) => item.linha), operadores: [...new Set(grupo.map((item) => item.operador ?? "(sem operador)"))],
    primeira: Math.min(...grupo.map((item) => item.leituraInicial ?? Infinity)), ultima: Math.max(...grupo.map((item) => item.leituraFinal ?? 0)),
    datas: [grupo.map((item) => item.data ?? "").sort()[0], grupo.map((item) => item.data ?? "").sort().at(-1)!],
  });
  return { baixo: resumo(baixo), alto: resumo(alto) };
}

export function totaisDiario(linhas: LinhaDiario[]) {
  const soma = (campo: keyof LinhaDiario) => linhas.reduce((total, item) => total + (typeof item[campo] === "number" ? item[campo] as number : 0), 0);
  return { linhas: linhas.length, viagens: soma("totalViagens"), volumePorto: Math.round(soma("volumePorto") * 100) / 100, toras: soma("torasPorto"), diesel: soma("diesel"), trabalhado: soma("trabalhado") };
}

// Código que não está no cadastro: equipamento cujo prefixo começa pelo código (ex.: HL-02 →
// "HL-02-QVN6E34"), se for um só.
export function casarPorPrefixo<E extends { id: number; prefix: string }>(codigo: string, equipamentos: E[]) {
  const chave = chaveEquipamento(codigo);
  const achados = equipamentos.filter((item) => chaveEquipamento(item.prefix).startsWith(`${chave}-`) || chaveEquipamento(item.prefix).startsWith(`${chave} `));
  return achados.length === 1 ? achados[0] : null;
}

// Leituras de um grupo que não bate com o cadastro (ex.: CA-01 com 280.000 km; CC-02 com 167.000 km):
// sugere o equipamento de outro código da MESMA planilha cuja faixa de leituras encosta na do grupo
// (ex.: o CC-02 em km continua no HL-02). Sem nenhum, sugere pelo cadastro (leitura atual mais
// próxima abaixo da primeira do grupo).
export function sugerirEquipamento(grupo: { primeira: number; ultima: number }, faixas: Array<{ equipmentId: number; min: number; max: number }>,
  cadastro: Array<{ id: number; atual: number }>) {
  // 1º a faixa que contém a do grupo; 2º a que mais se sobrepõe; 3º a que encosta mais perto.
  const folga = Math.max(500, (grupo.ultima - grupo.primeira) * 0.5);
  const encostam = faixas.filter((faixa) => faixa.min <= grupo.ultima + folga && faixa.max >= grupo.primeira - folga).map((faixa) => ({
    id: faixa.equipmentId, contem: faixa.min <= grupo.primeira && faixa.max >= grupo.ultima,
    sobreposicao: Math.max(0, Math.min(faixa.max, grupo.ultima) - Math.max(faixa.min, grupo.primeira)),
    distancia: Math.min(Math.abs(faixa.min - grupo.ultima), Math.abs(faixa.max - grupo.primeira)),
  })).sort((a, b) => Number(b.contem) - Number(a.contem) || b.sobreposicao - a.sobreposicao || a.distancia - b.distancia);
  if (encostam.length) return encostam[0].id;
  const abaixo = cadastro.filter((item) => item.atual > 0 && item.atual <= grupo.primeira && grupo.primeira - item.atual < Math.max(5000, grupo.primeira * 0.05))
    .sort((a, b) => (grupo.primeira - a.atual) - (grupo.primeira - b.atual));
  return abaixo[0]?.id ?? null;
}

// Diesel do diário: acima do limite não é lançado (é leitura digitada no campo de litros e afins).
export const DIESEL_LIMITE_LITROS = 600;
export function mesDoLote(datas: string[]) {
  const MESES = ["JANEIRO", "FEVEREIRO", "MARCO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
  const contagem = new Map<string, number>();
  for (const data of datas) contagem.set(data.slice(0, 7), (contagem.get(data.slice(0, 7)) ?? 0) + 1);
  const [mes] = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["0000-01"];
  return `IMPORTACAO_${MESES[Number(mes.slice(5, 7)) - 1]}_${mes.slice(0, 4)}`;
}
