import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";

// Seletor global de frente (topo do sistema). Quem enxerga mais de uma frente escolhe uma frente
// "em exibição" e ela passa a valer como filtro padrão em todas as telas que filtram por frente,
// sem precisar refiltrar tela a tela. A escolha viaja num cookie comum (não HttpOnly — é o próprio
// navegador que grava ao trocar o seletor) no formato "<userId>:<frenteId|ALL>". O userId evita que
// a escolha de uma pessoa vaze para outra que entre no mesmo navegador.
//
// IMPORTANTE: o cookie só RESTRINGE. Ele nunca amplia o que a pessoa enxerga — a fonte de verdade
// de visibilidade continua sendo lib/access.ts:frentesVisiveis. Frente escolhida que a pessoa não
// enxerga é ignorada.
export const ACTIVE_FRONT_COOKIE = "jc_active_front";

export function parseActiveFrontCookie(raw: string | null | undefined, userId: number): number | "ALL" {
  const value = (raw ?? "").trim();
  const match = /^(\d+):(ALL|\d+)$/.exec(value);
  if (!match || Number(match[1]) !== userId) return "ALL";
  return match[2] === "ALL" ? "ALL" : Number(match[2]);
}

export function readActiveFront(request: Request, userId: number): number | "ALL" {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === ACTIVE_FRONT_COOKIE) return parseActiveFrontCookie(decodeURIComponent(value.join("=")), userId);
  }
  return "ALL";
}

// Combina o que a pessoa enxerga com a frente escolhida no seletor global.
export function scopeFronts(visible: number[] | "ALL", selected: number | "ALL"): number[] | "ALL" {
  if (selected === "ALL") return visible;
  if (visible === "ALL") return [selected];
  return visible.includes(selected) ? [selected] : visible;
}

// Frentes em exibição para esta requisição: visibilidade ∩ seletor global.
export function frentesEmExibicao(user: SessionUser, request: Request): number[] | "ALL" {
  return scopeFronts(frentesVisiveis(user), readActiveFront(request, user.id));
}

// Quem pode ver dados de várias frentes (e por isso vê o seletor global e o detalhamento por frente).
export function seesMultipleFronts(user: SessionUser) {
  const visible = frentesVisiveis(user);
  return visible === "ALL" || visible.length > 1;
}
