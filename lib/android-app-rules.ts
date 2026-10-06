// App Android "JC Sistema" (pasta android-app/): regras puras do arquivo versao.json que o workflow
// "App Android" publica no servidor junto com o APK. Sem acesso a disco (testável).

export type AndroidVersionInfo = {
  versionCode: number;
  versionName: string;
  url: string;
  notas: string;
  obrigatoria: boolean;
  sha256: string | null;
  tamanho: number | null;
  publicadoEm: string | null;
};

// Mesma conta do android-app/app/build.gradle.kts e do workflow: 1.0.0 → 10000, 1.0.1 → 10001, 1.2.0 → 10200.
export function versionCodeFor(versionName: string) {
  const match = /^(\d{1,3})\.(\d{1,2})\.(\d{1,2})$/.exec(versionName.trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major * 10000 + minor * 100 + patch;
}

// Valida o versao.json lido do servidor. Qualquer campo essencial errado → null (a rota responde
// "não publicado" em vez de mandar o celular baixar algo incoerente).
export function parseVersionInfo(raw: unknown): AndroidVersionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const versionName = typeof data.versionName === "string" ? data.versionName.trim() : "";
  const versionCode = Number(data.versionCode);
  if (!Number.isInteger(versionCode) || versionCode <= 0 || versionCodeFor(versionName) !== versionCode) return null;
  const url = typeof data.url === "string" ? data.url.trim() : "";
  if (!/^https:\/\//.test(url)) return null;
  const sha256 = typeof data.sha256 === "string" && /^[0-9a-f]{64}$/i.test(data.sha256) ? data.sha256.toLowerCase() : null;
  const tamanho = Number.isInteger(Number(data.tamanho)) && Number(data.tamanho) > 0 ? Number(data.tamanho) : null;
  return {
    versionCode, versionName, url, notas: typeof data.notas === "string" ? data.notas.trim().slice(0, 2000) : "",
    obrigatoria: data.obrigatoria === true, sha256, tamanho, publicadoEm: typeof data.publicadoEm === "string" ? data.publicadoEm : null,
  };
}

export function formatApkSize(bytes: number | null) {
  if (!bytes) return null;
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

// Quem está abrindo a página de download (pelo User-Agent).
export function deviceKind(userAgent: string): "APP_ANDROID" | "IPHONE" | "ANDROID" | "OUTRO" {
  if (/JCSistemaAndroid\//.test(userAgent)) return "APP_ANDROID";
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile/.test(userAgent))) return "IPHONE";
  if (/Android/i.test(userAgent)) return "ANDROID";
  return "OUTRO";
}
