import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { parseVersionInfo, type AndroidVersionInfo } from "./android-app-rules";

// Onde ficam o APK e o versao.json publicados pelo workflow "App Android" (.github/workflows/android-app.yml).
// No servidor: pasta android-releases ao lado do server.js (o deploy do site não apaga). Pode ser
// trocada pela variável ANDROID_RELEASES_DIR.
export function androidReleasesDir() {
  return process.env.ANDROID_RELEASES_DIR?.trim() || path.join(process.cwd(), "android-releases");
}

const APK_FILE = "jc-sistema.apk";

export async function readAndroidVersion(): Promise<AndroidVersionInfo | null> {
  const dir = androidReleasesDir();
  try {
    const info = parseVersionInfo(JSON.parse(await readFile(path.join(dir, "versao.json"), "utf8")));
    if (!info) return null;
    // Sem o APK no lugar, não anuncia versão nenhuma (o celular baixaria um erro).
    await stat(path.join(dir, APK_FILE));
    return info;
  } catch {
    return null;
  }
}

export async function openAndroidApk() {
  const file = path.join(androidReleasesDir(), APK_FILE);
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    return { size: info.size, modified: info.mtime, stream: () => Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array> };
  } catch {
    return null;
  }
}
