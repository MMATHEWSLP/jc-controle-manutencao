import type { SessionUser } from "./auth";

// Único ponto que decide quais frentes de serviço um usuário enxerga. Toda consulta que filtra
// por frente (lib/front-scope.ts, rotas de exportação, etc.) passa por aqui — nunca reimplemente
// esta regra em outro lugar.
//
// Perfil (ADMIN/GESTOR/USUÁRIO) define o que a pessoa PODE FAZER; frente define o que ela ENXERGA.
// São coisas independentes: um USUÁRIO comum pode enxergar todas as frentes, e um GESTOR pode
// enxergar só uma.
export function frentesVisiveis(user: SessionUser): number[] | "ALL" {
  if (user.profile === "ADMIN") return "ALL";
  if (user.allServiceFronts) return "ALL";
  return user.serviceFrontIds;
}

// Equipamentos e Funcionários (cadastro/listagem/transferência) têm uma exceção por usuário: a
// permissão "fronts.cross_registry" libera enxergar TODAS as frentes só nesses dois módulos, para
// localizar e transferir um equipamento ou funcionário que está em outra frente. Os demais módulos
// continuam usando frentesVisiveis().
export function frentesVisiveisCadastro(user: SessionUser): number[] | "ALL" {
  if (user.permissions.includes("fronts.cross_registry")) return "ALL";
  return frentesVisiveis(user);
}
