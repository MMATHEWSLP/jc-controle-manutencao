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
export type AvisoDia = "ZERO_NO_MESMO_DIA" | "LEITURAS_IGUAIS_NO_DIA";
export const MOTIVO_ROTULO: Record<MotivoConferir | AvisoDia, string> = {
  FINAL_MENOR_QUE_INICIAL: "Leitura final menor que a inicial", INICIAL_MENOR_QUE_FINAL_ANTERIOR: "Inicial menor que a final do dia anterior", SEM_LEITURA: "Sem leitura inicial/final",
  ZERO_NO_MESMO_DIA: "0 trabalhado e outro registro no mesmo dia", LEITURAS_IGUAIS_NO_DIA: "Mesmas leituras de outro registro do dia",
};

type ComLeitura = Pick<LinhaDiario, "linha" | "data" | "leituraInicial" | "leituraFinal">;

// Por equipamento (já separado: o CC-02 dividido em dois vira duas chaves), em ordem de data:
// final < inicial, ou inicial menor que a maior final de um dia anterior → "Conferir".
// Mais de um registro no mesmo dia: só sinaliza (0 trabalhado ou leituras iguais a outro do dia).
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
      if (item.leituraInicial !== null && item.leituraFinal !== null && item.leituraFinal === item.leituraInicial) add(avisos, item.linha, "ZERO_NO_MESMO_DIA");
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
