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
