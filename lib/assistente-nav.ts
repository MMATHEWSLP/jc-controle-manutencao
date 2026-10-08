// "Ver no sistema" do Assistente JC: abre a tela correspondente já com os filtros da consulta.
// O painel grava os filtros em sessionStorage e dispara o evento "jc:navegar"; a página troca de tela
// e a tela lê (uma vez) os filtros que são dela. Sem dependências: roda no navegador.
export type NavegacaoAssistente = { secao: string; de?: string; ate?: string; busca?: string; tipo?: "ENTRADA" | "SAIDA" | "TRANSFERENCIA"; frenteId?: number };

const KEY = "jc:assistente-filtros";
export const NAVEGAR_EVENTO = "jc:navegar";

export function navegarParaTela(navegacao: NavegacaoAssistente) {
  try { window.sessionStorage.setItem(KEY, JSON.stringify({ ...navegacao, em: Date.now() })); } catch { /* sem sessionStorage: abre a tela sem filtro */ }
  window.dispatchEvent(new CustomEvent(NAVEGAR_EVENTO, { detail: navegacao }));
}

// Filtros pendentes para esta tela (vale por 1 minuto e só uma vez).
export function consumirFiltros(secao: string): NavegacaoAssistente | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as NavegacaoAssistente & { em?: number };
    if (data.secao !== secao || !data.em || Date.now() - data.em > 60_000) return null;
    window.sessionStorage.removeItem(KEY);
    return data;
  } catch { return null; }
}

// Telas que viraram subabas: o nome antigo (Assistente JC, atalhos) abre o lugar novo.
// "Abastecimentos" (menu ABASTECIMENTOS, removido) → Combustível → Aprovação.
// "Custos e Consumo" e "Resumo semanal" (saíram de EQUIPAMENTOS) → RELATÓRIOS, no relatório
// (a aba é o id do relatório em lib/reports-catalog.ts).
export const TELAS_ANTIGAS: Record<string, { secao: string; aba: string }> = {
  Abastecimentos: { secao: "Combustível", aba: "aprovacao" },
  "Custos e Consumo": { secao: "Relatórios", aba: "custos-consumo" },
  "Resumo semanal": { secao: "Relatórios", aba: "resumo-semanal" },
};
let abaPedida: { secao: string; aba: string; detalhe?: Record<string, unknown>; em: number } | null = null;

// Pede que a tela abra numa subaba (vale por 1 minuto e só uma vez).
export function pedirAba(secao: string, aba: string, detalhe?: Record<string, unknown>) {
  abaPedida = { secao, aba, detalhe, em: Date.now() };
}
export function consumirAba(secao: string): { aba: string; detalhe?: Record<string, unknown> } | null {
  const pedido = abaPedida;
  if (!pedido || pedido.secao !== secao || Date.now() - pedido.em > 60_000) return null;
  abaPedida = null;
  return { aba: pedido.aba, detalhe: pedido.detalhe };
}
// Nome de tela que pode ser antigo → tela atual (e a subaba pedida, se houver).
export function telaAtual(secao: string) {
  const nova = TELAS_ANTIGAS[secao];
  if (!nova) return secao;
  pedirAba(nova.secao, nova.aba);
  return nova.secao;
}
