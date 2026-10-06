import { openAndroidApk, readAndroidVersion } from "../../../lib/android-app";

// O instalador do app Android (última versão publicada pelo workflow "App Android"). Público.
export const dynamic = "force-dynamic";

async function respond(withBody: boolean) {
  const apk = await openAndroidApk();
  if (!apk) return new Response("O app Android ainda não foi publicado.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const info = await readAndroidVersion();
  return new Response(withBody ? apk.stream() : null, {
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="jc-sistema${info ? `-${info.versionName}` : ""}.apk"`,
      "Content-Length": String(apk.size),
      "Last-Modified": apk.modified.toUTCString(),
      ...(info?.sha256 ? { ETag: `"${info.sha256}"` } : {}),
      // Sempre confere com o servidor: a versão nova substitui o arquivo no mesmo endereço.
      "Cache-Control": "no-cache",
    },
  });
}

export async function GET() { return respond(true); }
export async function HEAD() { return respond(false); }
