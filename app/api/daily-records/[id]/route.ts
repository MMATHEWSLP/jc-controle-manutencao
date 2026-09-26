import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { checkReading, validateDailyRecord, type DailyRecordDraft } from "../../../../lib/daily-record-rules";
import { DailyRecordError, deleteDailyRecord, lastReadingDateBefore, requireEquipment, requireManagedRecord, updateDailyRecord } from "../../../../lib/daily-records";

// Editar e excluir registros do Controle Diário: somente quem tem "daily.manage"
// (o ADMIN libera por usuário em Usuários → Permissões), nas frentes que enxerga.
type Context = { params: Promise<{ id: string }> };

async function recordId(params: Context["params"]) {
  const id = Number((await params).id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Multipart igual ao envio: "payload" + fotos novas (opcionais). Fotos já existentes são
// mantidas quando payload.keepProblemPhoto / keepProductionPhoto = true.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.manage"); if (auth.response) return auth.response;
  try {
    const id = await recordId(params);
    if (!id) return Response.json({ error: "Registro inválido." }, { status: 400 });
    const current = await requireManagedRecord(auth.user!, id);
    const form = await request.formData();
    const draft = JSON.parse(String(form.get("payload") ?? "{}")) as DailyRecordDraft & { keepProblemPhoto?: boolean; keepProductionPhoto?: boolean };
    const problem = form.get("problemPhoto");
    const production = form.get("productionPhoto");
    const photos = {
      problem: problem instanceof File && problem.size > 0 ? problem : null,
      production: production instanceof File && production.size > 0 ? production : null,
      keepProblem: draft.keepProblemPhoto === true, keepProduction: draft.keepProductionPhoto === true,
    };
    const { errors, value } = validateDailyRecord({ ...draft,
      hasProblemPhoto: Boolean(photos.problem) || (photos.keepProblem && Boolean(current.record.problemPhotoKey)),
      hasProductionPhoto: Boolean(photos.production) || (photos.keepProduction && Boolean(current.record.productionPhotoKey)),
    }, new Date().toISOString().slice(0, 10));
    if (!value) return Response.json({ error: Object.values(errors)[0] ?? "Revise os campos do formulário.", fields: errors }, { status: 400 });
    if (value.workedToday) {
      const item = await requireEquipment(auth.user!, value.equipmentId);
      const check = checkReading({ unit: item.readingUnit, start: value.startReading, end: value.endReading,
        lastDate: await lastReadingDateBefore(value.equipmentId, item.readingUnit, value.recordDate), recordDate: value.recordDate });
      if (check.level === "INVALID") return Response.json({ error: check.message, fields: { endReading: check.message } }, { status: 400 });
      if (check.level === "HIGH" && draft.confirmUnusualReading !== true) return Response.json({ error: check.message, fields: { endReading: check.message }, requiresConfirmation: true }, { status: 400 });
    }
    const result = await updateDailyRecord(auth.user!, id, value, photos);
    return Response.json({ ok: true, id, message: `Registro do ${result.prefix} atualizado.` });
  } catch (error) {
    if (error instanceof DailyRecordError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "Dados do formulário inválidos." }, { status: 400 });
    console.error("[daily-records.put]", error);
    return Response.json({ error: "O registro não foi alterado. Tente novamente." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.manage"); if (auth.response) return auth.response;
  try {
    const id = await recordId(params);
    if (!id) return Response.json({ error: "Registro inválido." }, { status: 400 });
    await deleteDailyRecord(auth.user!, id);
    return Response.json({ ok: true, message: "Registro excluído." });
  } catch (error) {
    if (error instanceof DailyRecordError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[daily-records.delete]", error);
    return Response.json({ error: "O registro não foi excluído. Tente novamente." }, { status: 500 });
  }
}
