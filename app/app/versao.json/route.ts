import { readAndroidVersion } from "../../../lib/android-app";

// Consultado pelo app Android (no máximo a cada 6 h) para saber se há versão nova. Público.
export const dynamic = "force-dynamic";

export async function GET() {
  const info = await readAndroidVersion();
  if (!info) return Response.json({ error: "O app Android ainda não foi publicado." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json(info, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}
