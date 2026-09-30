import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { canUseAssistant } from "../../../../../lib/assistant-config";
import { canImportFuel } from "../../../../../lib/fuel-import";
import { buildFuelImportWorkbook } from "../../../../../lib/fuel-import-model";
import { readRawRows } from "../../../../../lib/fuel-import-rules";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const file = (buffer: Buffer, name: string) => new Response(new Uint8Array(buffer), { headers: { "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });

// Modelo vazio (cabeçalho + Instruções + Listas).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  if (!canImportFuel(auth.user!)) return Response.json({ error: "Somente administrador ou gestor importa abastecimentos." }, { status: 403 });
  try { return file(await buildFuelImportWorkbook(await getDb(), auth.user!), "modelo-importacao-abastecimentos.xlsx"); }
  catch (error) { console.error("[fuel.import.model]", error); return Response.json({ error: "Não foi possível gerar o modelo." }, { status: 500 }); }
}

// Mesmo modelo já com linhas (ex.: só as linhas com erro, com a coluna "erro", ou as linhas lidas
// de uma ficha pelo Assistente JC — por isso quem usa o assistente também pode gerar).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  if (!canImportFuel(auth.user!) && !canUseAssistant(auth.user!)) return Response.json({ error: "Somente administrador ou gestor importa abastecimentos." }, { status: 403 });
  try {
    const body = await request.json() as { rows?: unknown; fileName?: unknown };
    const input = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
    const raws = readRawRows(input);
    const rows = raws.map((raw, index) => ({ values: raw.values, error: String((input[index] as { error?: unknown })?.error ?? "").slice(0, 500) || undefined }));
    const name = String(body.fileName ?? "abastecimentos.xlsx").replace(/[^\w.-]+/g, "-").slice(0, 80) || "abastecimentos.xlsx";
    return file(await buildFuelImportWorkbook(await getDb(), auth.user!, rows), name.endsWith(".xlsx") ? name : `${name}.xlsx`);
  } catch (error) { console.error("[fuel.import.model.rows]", error); return Response.json({ error: "Não foi possível gerar a planilha." }, { status: 500 }); }
}
