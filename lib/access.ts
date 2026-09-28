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

// Equipamentos e Funcionários (cadastro/listagem/transferência) são a exceção: QUALQUER pessoa com
// acesso a esses módulos enxerga TODAS as frentes neles, para localizar e transferir um equipamento
// ou funcionário que está em outra frente. É só VISUALIZAÇÃO e TRANSFERÊNCIA — editar, lançar ciclo,
// demitir etc. continuam limitados às frentes do login (frentesVisiveis). Os demais módulos continuam
// usando frentesVisiveis().
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function frentesVisiveisCadastro(_user: SessionUser): number[] | "ALL" {
  return "ALL";
}
