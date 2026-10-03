import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { DailyImportError, exigeAdmin, iniciarImportacao, listarLotes, previaDiario, type AjustesDiario } from "../../../../lib/daily-import";

const MAX_BYTES = 10 * 1024 * 1024;
const erro = (error: unknown, contexto: string) => {
  if (error instanceof DailyImportError) return Response.json({ error: error.message }, { status: error.status });
  console.error(`[daily-import.${contexto}]`, error instanceof Error ? error.message : error);
  return Response.json({ error: "Não foi possível processar a planilha agora." }, { status: 500 });
};

// Lotes já importados (para continuar, conferir ou desfazer).
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  try { exigeAdmin(auth.user!); return Response.json({ lotes: await listarLotes() }); }
  catch (error) { return erro(error, "lotes"); }
}

// FormData: arquivo, ajustes (JSON) e acao = "previa" (não grava) ou "iniciar" (cria o lote com o plano aprovado).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    exigeAdmin(auth.user!);
    const form = await request.formData();
    const arquivo = form.get("arquivo");
    if (!(arquivo instanceof File) || !arquivo.size) return Response.json({ error: "Escolha a planilha .xlsx." }, { status: 400 });
    if (arquivo.size > MAX_BYTES) return Response.json({ error: "Planilha grande demais (máximo 10 MB)." }, { status: 400 });
    const bruto = JSON.parse(String(form.get("ajustes") ?? "{}")) as Partial<AjustesDiario>;
    const ajustes: AjustesDiario = {
      equipamentos: Object.fromEntries(Object.entries(bruto.equipamentos ?? {}).map(([chave, valor]) => [chave.slice(0, 40), valor === null ? null : Number(valor) || null])),
      problemas: Array.isArray(bruto.problemas) ? bruto.problemas.map(Number).filter(Number.isInteger) : [],
    };
    const buffer = await arquivo.arrayBuffer();
    if (form.get("acao") === "iniciar") return Response.json(await iniciarImportacao(auth.user!, buffer, arquivo.name, ajustes), { status: 201 });
    return Response.json(await previaDiario(auth.user!, buffer, ajustes));
  } catch (error) { return erro(error, "post"); }
}
