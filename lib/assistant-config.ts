import type { Profile, SessionUser } from "./auth";

// ---------------------------------------------------------------------------
// Assistente JC — configuração por variável de ambiente (Hostinger → Variáveis de ambiente).
//  ANTHROPIC_API_KEY           chave da API (obrigatória; só no servidor, nunca vai para o navegador)
//  ASSISTANT_MODEL             modelo (padrão claude-sonnet-5-5)
//  ASSISTANT_PROFILES          perfis liberados, separados por vírgula (padrão ADMIN,GESTOR;
//                              ex.: ADMIN,GESTOR,OFICINA,OPERADOR,ALMOXARIFADO para liberar aos usuários)
//  ASSISTANT_DAILY_MESSAGES    perguntas por usuário por dia (padrão 40)
//  ASSISTANT_DAILY_PHOTOS      fotos de ficha por usuário por dia (padrão 20)
//  ASSISTANT_MAX_TOKENS        teto de tokens de saída por resposta do chat (padrão 4000)
//  ASSISTANT_TIMEOUT_SECONDS   tempo máximo de cada chamada à API (padrão 60; a leitura de ficha usa o dobro)
//  ASSISTANT_LAUNCH_PROFILES   perfis que podem usar "Lançar tudo" nos lançamentos pendentes (padrão ADMIN,GESTOR)
// ---------------------------------------------------------------------------
export const DEFAULT_ASSISTANT_MODEL = "claude-sonnet-5-5";
export const ASSISTANT_PROFILES: Profile[] = ["ADMIN", "GESTOR", "OFICINA", "OPERADOR", "ALMOXARIFADO", "CAMPO"];

const env = (name: string) => String((process.env as Record<string, string | undefined>)[name] ?? "").trim();
const intEnv = (name: string, fallback: number, min: number, max: number) => {
  const raw = env(name);
  const value = Number(raw);
  return raw !== "" && Number.isFinite(value) && value >= min ? Math.min(Math.floor(value), max) : fallback;
};

export function assistantConfig() {
  const launchProfiles = env("ASSISTANT_LAUNCH_PROFILES").toUpperCase().split(/[,;\s]+/).filter((item): item is Profile => (ASSISTANT_PROFILES as string[]).includes(item));
  const profiles = env("ASSISTANT_PROFILES").toUpperCase().split(/[,;\s]+/).filter((item): item is Profile => (ASSISTANT_PROFILES as string[]).includes(item));
  return {
    configured: env("ANTHROPIC_API_KEY").length > 0,
    model: env("ASSISTANT_MODEL") || DEFAULT_ASSISTANT_MODEL,
    profiles: profiles.length ? profiles : (["ADMIN", "GESTOR"] as Profile[]),
    launchProfiles: launchProfiles.length ? launchProfiles : (["ADMIN", "GESTOR"] as Profile[]),
    dailyMessages: intEnv("ASSISTANT_DAILY_MESSAGES", 40, 0, 1000),
    dailyPhotos: intEnv("ASSISTANT_DAILY_PHOTOS", 20, 0, 500),
    maxTokens: intEnv("ASSISTANT_MAX_TOKENS", 4000, 500, 32000),
    timeoutMs: intEnv("ASSISTANT_TIMEOUT_SECONDS", 60, 10, 300) * 1000,
  };
}

export const canUseAssistant = (user: SessionUser) => assistantConfig().profiles.includes(user.profile);

// Limites de envio de uma ficha.
export const FICHA_MAX_PHOTOS = 6;
export const FICHA_MAX_BYTES = 4_500_000;
export const FICHA_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type FichaMediaType = typeof FICHA_MEDIA_TYPES[number];
