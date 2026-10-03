// Decisões combinadas para a importação do Controle Diário de setembro/2026 (usadas pela prévia e
// pela importação rodadas no workflow): CA-01 (Antonio Francisco, ~280.000 km) → CC-01; CC-02 na
// escala de km (~167.000) → HL-02; os demais grupos "a decidir" ficam com a sugestão da prévia.
import type { PreviaDiario } from "../lib/daily-import";

export function decisoesCombinadas(previa: PreviaDiario) {
  const porPrefixo = (inicio: string) => previa.equipamentosCadastro.filter((item) => item.prefix.toUpperCase().startsWith(inicio));
  const equipamentos: Record<string, number | null> = {};
  const linhas: string[] = [];
  for (const grupo of previa.grupos.filter((item) => item.situacao === "DECIDIR")) {
    let escolha: number | null = grupo.sugestaoId; let regra = "sugestão";
    if (grupo.codigo === "CA-01") { const cc = porPrefixo("CC-01"); if (cc.length === 1) { escolha = cc[0].id; regra = "combinado: CA-01 é o CC-01"; } }
    if (grupo.codigo === "CC-02" && grupo.escala === "B") { const hl = porPrefixo("HL-02"); if (hl.length === 1) { escolha = hl[0].id; regra = "combinado: CC-02 em km é o HL-02"; } }
    equipamentos[grupo.chave] = escolha;
    const alvo = previa.equipamentosCadastro.find((item) => item.id === escolha);
    linhas.push(`  ${grupo.chave}: ${grupo.linhas} linha(s) · ${grupo.operadores.join(", ")} · ${grupo.motivo}\n     → ${alvo ? `${alvo.prefix} (${alvo.model})` : "NÃO IMPORTAR"} [${regra}]`);
  }
  return { equipamentos, linhas };
}
