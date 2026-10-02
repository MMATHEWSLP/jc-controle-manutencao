import { getDb } from "../../../db";
import { frentesEmExibicao } from "../../../lib/active-front";
import { AssistantError, assistantUsageToday, readHistory, runAssistantChat } from "../../../lib/assistant";
import { assistantConfig, canUseAssistant } from "../../../lib/assistant-config";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { canImportFuel } from "../../../lib/fuel-import";
import { assistantDbMode } from "../../../lib/assistente/db";
import { podeLancarPendentes } from "../../../lib/assistente/pendentes";

export const maxDuration = 180;

// Estado do botão "Assistente JC": se aparece para este usuário, se está configurado e quanto resta do limite do dia.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canUseAssistant(user)) return Response.json({ allowed: false });
  try {
    const config = assistantConfig();
    return Response.json({
      allowed: true, configured: config.configured, usage: await assistantUsageToday(await getDb(), user.id),
      canReadSheet: user.permissions.includes("fuel.view"), canImport: canImportFuel(user) && user.permissions.includes("fuel.register"),
      canLaunch: podeLancarPendentes(user),
      ...(user.profile === "ADMIN" ? { dbMode: assistantDbMode() } : {}),
    });
  } catch (error) {
    console.error("[assistente.get]", error);
    return Response.json({ allowed: true, configured: false, error: "Não foi possível carregar o assistente agora." });
  }
}

// Pergunta do chat. Só consulta: as ferramentas não gravam nada.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canUseAssistant(user)) return Response.json({ error: "O Assistente JC não está liberado para o seu perfil." }, { status: 403 });
  try {
    const body = (await request.json()) as { question?: unknown; history?: unknown; voz?: unknown };
    const question = typeof body.question === "string" ? body.question.trim().slice(0, 1500) : "";
    if (!question) return Response.json({ error: "Escreva a pergunta." }, { status: 400 });
    // voz = a pergunta foi ditada no microfone (só o texto chega aqui; o áudio fica no navegador).
    const result = await runAssistantChat({ db: await getDb(), user, displayed: frentesEmExibicao(user, request) }, question, readHistory(body.history), { viaVoz: body.voz === true });
    return Response.json(result);
  } catch (error) {
    if (error instanceof AssistantError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[assistente.post]", error);
    return Response.json({ error: "Não foi possível responder agora. Tente de novo em instantes." }, { status: 500 });
  }
}
