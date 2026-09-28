import { frentesVisiveis } from "./access";
import { frentesEmExibicao } from "./active-front";
import type { SessionUser } from "./auth";

// Frentes cujos pedidos quem trabalha no fluxo de Compras enxerga: seletor global ∩ frentes da pessoa.
export function purchaseFronts(user: SessionUser, request: Request): number[] | "ALL" {
  const displayed = frentesEmExibicao(user, request);
  return displayed === "ALL" ? frentesVisiveis(user) : displayed;
}
