// Ponte para o motor de recálculo já existente no sistema (TypeScript).
// O importador de equipamentos é um script .mjs simples (mesmo padrão dos
// outros scripts da raiz), então este arquivo é empacotado em tempo de
// execução via esbuild — igual já é feito para os testes do projeto — em
// vez de duplicar a lógica de cálculo de plano de manutenção aqui.
export { getD1 } from "../../db";
export { recalculateMaintenanceCycles } from "../../lib/maintenance-recalculation";
