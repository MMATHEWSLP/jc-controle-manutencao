import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { applyBlock, finishImport, listBatches, PersonnelImportError, previewImport, requireAdmin, startImport, type Decisions } from "../../../../lib/personnel-import";

// Importar do sistema de pessoal (FUNCIONÁRIOS, só ADMIN). Nunca registra conteúdo da planilha em log.
export const maxDuration = 300;
const MAX_BYTES = 15 * 1024 * 1024;

const failure = (error: unknown, context: string) => {
  if (error instanceof PersonnelImportError) return Response.json({ error: error.message }, { status: error.status });
  console.error(`[personnel-import.${context}]`, error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "erro");
  return Response.json({ error: "Não foi possível processar a exportação agora." }, { status: 500 });
};

function parseDecisions(raw: FormDataEntryValue | null): Decisions {
  try {
    const value = JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
    const decisions: Decisions = {};
    for (const [key, decision] of Object.entries(value).slice(0, 5000)) {
      const id = Number(decision);
      if (decision === "NOVO") decisions[key.slice(0, 40)] = "NOVO";
      else if (Number.isInteger(id) && id > 0) decisions[key.slice(0, 40)] = id;
    }
    return decisions;
  } catch { return {}; }
}

// Lotes já importados (para conferir ou desfazer).
export async function GET(request: Request) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try { return Response.json({ batches: await listBatches(auth.user!) }); }
  catch (error) { return failure(error, "list"); }
}

// FormData: arquivo, decisoes (JSON: ID sistema → id do funcionário ou "NOVO") e acao:
//   "previa" (não grava) · "iniciar" (cria o lote e grava empresas/funções) ·
//   "bloco" (loteId, bloco: grava um bloco de pessoas) · "concluir" (loteId).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    requireAdmin(user);
    const form = await request.formData();
    const action = String(form.get("acao") ?? "previa");
    if (action === "concluir") return Response.json(await finishImport(user, Number(form.get("loteId"))));
    const file = form.get("arquivo");
    if (!(file instanceof File) || !file.size) return Response.json({ error: "Escolha a exportação .xlsx do sistema de pessoal." }, { status: 400 });
    if (file.size > MAX_BYTES) return Response.json({ error: "Arquivo grande demais (máximo 15 MB)." }, { status: 400 });
    const buffer = await file.arrayBuffer();
    const decisions = parseDecisions(form.get("decisoes"));
    if (action === "iniciar") return Response.json(await startImport(user, buffer, file.name, decisions), { status: 201 });
    if (action === "bloco") return Response.json(await applyBlock(user, Number(form.get("loteId")), Number(form.get("bloco")), buffer, decisions));
    return Response.json(await previewImport(user, buffer, file.name, decisions));
  } catch (error) { return failure(error, "post"); }
}
