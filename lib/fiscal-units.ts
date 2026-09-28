// Unidades de medida fiscais (as que aparecem na nota fiscal/compra). Lista única usada na
// Solicitação de Materiais e na Solicitação de Pedidos (Compras) — sem dependências, roda no
// navegador e no servidor.
export const FISCAL_UNITS = [
  ["UN", "Unidade"], ["PC", "Peça"], ["CJ", "Conjunto"], ["JG", "Jogo"], ["KIT", "Kit"], ["PAR", "Par"],
  ["CX", "Caixa"], ["PCT", "Pacote"], ["FD", "Fardo"], ["SC", "Saco"], ["RL", "Rolo"],
  ["L", "Litro"], ["ML", "Mililitro"], ["GL", "Galão"], ["BD", "Balde"], ["TB", "Tambor"],
  ["KG", "Quilograma"], ["G", "Grama"], ["TON", "Tonelada"],
  ["M", "Metro"], ["M2", "Metro quadrado"], ["M3", "Metro cúbico"],
] as const;

export type FiscalUnit = typeof FISCAL_UNITS[number][0];
export const DEFAULT_FISCAL_UNIT: FiscalUnit = "UN";

export function isFiscalUnit(value: unknown): value is FiscalUnit {
  return typeof value === "string" && FISCAL_UNITS.some(([code]) => code === value);
}
