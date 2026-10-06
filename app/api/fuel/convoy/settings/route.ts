import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { ConvoyError, convoySettings, saveConvoySettings } from "../../../../../lib/convoy";
import { convoyStorageMode } from "../../../../../lib/convoy-storage";
import { assistantConfig } from "../../../../../lib/assistant-config";

export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  return Response.json({ settings: await convoySettings(await getDb()), storage: convoyStorageMode(), assistantConfigured: assistantConfig().configured, canConfigure: auth.user!.profile === "ADMIN" });
}

// Só ADMIN: foto da bomba obrigatória e conferência automática da foto.
export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const settings = await saveConvoySettings(await getDb(), auth.user!, {
      pumpPhotoRequired: typeof body.pumpPhotoRequired === "boolean" ? body.pumpPhotoRequired : undefined,
      aiPhotoCheck: typeof body.aiPhotoCheck === "boolean" ? body.aiPhotoCheck : undefined,
    });
    return Response.json({ settings, message: "Configuração do comboio salva." });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.settings]", error);
    return Response.json({ error: "Não foi possível salvar." }, { status: 500 });
  }
}
