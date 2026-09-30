import { authorize, assertSameOrigin } from "../../../lib/auth";
import { checklistErrorResponse, checklistForEquipment, listChecklists, readSubmitPayload, submitChecklist } from "../../../lib/checklists";
import { canRegister, canViewAll } from "../../../lib/daily-records";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());

// ?equipamento=ID → modelo de checklist do equipamento e os já feitos hoje.
// ?data=AAAA-MM-DD&situacao=&meus=1 → painel dos checklists do dia.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const url = new URL(request.url);
    const equipmentId = Number(url.searchParams.get("equipamento"));
    if (equipmentId > 0) return Response.json(await checklistForEquipment(user, equipmentId), { headers: { "Cache-Control": "no-store" } });
    const date = url.searchParams.get("data") ?? "";
    return Response.json(await listChecklists(user, { date: DAY.test(date) ? date : today(), status: url.searchParams.get("situacao"), onlyMine: url.searchParams.get("meus") === "1" }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = checklistErrorResponse(error); if (known) return known;
    console.error("[checklists.get]", error);
    return Response.json({ error: "Não foi possível carregar o checklist agora." }, { status: 500 });
  }
}

// Envio (multipart): "payload" (JSON) + fotos "photo_<itemId>" dos itens Não OK.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.register");
  if (auth.response) return auth.response;
  try {
    const form = await request.formData();
    const photos = new Map<number, File>();
    for (const [key, value] of form.entries()) {
      const match = /^photo_(\d+)$/.exec(key);
      if (match && value instanceof File && value.size > 0) photos.set(Number(match[1]), value);
    }
    const result = await submitChecklist(auth.user!, readSubmitPayload(String(form.get("payload") ?? "")), photos);
    const message = result.duplicate ? "Este checklist já tinha sido enviado." : result.status === "OK" ? "Checklist enviado: tudo OK." : result.status === "BLOQUEADO"
      ? `Checklist enviado: item que BLOQUEIA com problema — não opere o equipamento.${result.workOrderNumber ? ` ${result.createdOrder ? "Aberta a" : "Ligado à"} ${result.workOrderNumber}.` : ""}`
      : `Checklist enviado com pendência.${result.workOrderNumber ? ` ${result.createdOrder ? "Aberta a" : "Ligado à"} ${result.workOrderNumber}.` : ""}`;
    return Response.json({ ...result, message });
  } catch (error) {
    const known = checklistErrorResponse(error); if (known) return known;
    console.error("[checklists.post]", error);
    return Response.json({ error: "Não foi possível enviar o checklist agora." }, { status: 500 });
  }
}
