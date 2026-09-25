import { assertSameOrigin, authorize } from "../../../lib/auth";
import { validateDailyRecord, type DailyRecordDraft } from "../../../lib/daily-record-rules";
import { canRegister, canViewAll, createDailyRecord, DailyRecordError, listDailyRecords } from "../../../lib/daily-records";

const isoDate = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const equipmentId = Number(params.get("equipmentId"));
    const records = await listDailyRecords(user, {
      from: isoDate(params.get("from")), to: isoDate(params.get("to")),
      equipmentId: Number.isInteger(equipmentId) && equipmentId > 0 ? equipmentId : undefined,
      onlyMine: params.get("scope") !== "all",
    });
    return Response.json({ records });
  } catch (error) {
    console.error("[daily-records.get]", error);
    return Response.json({ error: "Não foi possível carregar os registros agora." }, { status: 500 });
  }
}

// Multipart: "payload" (JSON do formulário) + "problemPhoto" (opcional) + "productionPhoto".
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.register"); if (auth.response) return auth.response;
  try {
    const form = await request.formData();
    const draft = JSON.parse(String(form.get("payload") ?? "{}")) as DailyRecordDraft;
    const problem = form.get("problemPhoto");
    const production = form.get("productionPhoto");
    const photos = { problem: problem instanceof File && problem.size > 0 ? problem : null, production: production instanceof File && production.size > 0 ? production : null };
    const today = new Date().toISOString().slice(0, 10);
    const { errors, value } = validateDailyRecord({ ...draft, hasProblemPhoto: Boolean(photos.problem), hasProductionPhoto: Boolean(photos.production) }, today);
    if (!value) return Response.json({ error: Object.values(errors)[0] ?? "Revise os campos do formulário.", fields: errors }, { status: 400 });
    const result = await createDailyRecord(auth.user!, value, photos);
    return Response.json({ ok: true, id: result.id, message: `Controle Diário do ${result.prefix} enviado.` }, { status: 201 });
  } catch (error) {
    if (error instanceof DailyRecordError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "Dados do formulário inválidos." }, { status: 400 });
    console.error("[daily-records.post]", error);
    return Response.json({ error: "O registro não foi salvo. Nenhuma alteração foi aplicada; tente novamente." }, { status: 500 });
  }
}
