import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { approveConvoyRecord, ConvoyError, listConvoyRecords, rejectConvoyRecord, requestConvoyCorrection } from "../../../../../lib/convoy";
import { checkConvoyPhoto } from "../../../../../lib/convoy-ai";
import { parseConvoyNumber } from "../../../../../lib/convoy-rules";

type Context = { params: Promise<{ id: string }> };

// Ações do aprovador num registro: approve (com correções e a origem Frente/Porto), reject (motivo
// obrigatório), request_correction (o motorista vê o pedido) e ai_check (conferir a foto agora).
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Registro inválido." }, { status: 400 });
    const body = (await request.json()) as Record<string, unknown>;
    const user = auth.user!;
    if (body.action === "approve") {
      const number = (key: string) => (body[key] === undefined ? undefined : body[key] === null || body[key] === "" ? null : parseConvoyNumber(body[key]));
      const liters = number("liters"), reading = number("reading");
      if (liters !== undefined && (liters === null || Number.isNaN(liters))) return Response.json({ error: "Informe a quantidade em litros." }, { status: 400 });
      if (reading !== undefined && reading !== null && Number.isNaN(reading)) return Response.json({ error: "Leitura inválida." }, { status: 400 });
      const result = await approveConvoyRecord(user, id, {
        liters: liters ?? undefined, reading, equipmentId: Number(body.equipmentId) || undefined,
        operatorEmployeeId: body.operatorEmployeeId === undefined ? undefined : Number(body.operatorEmployeeId) || null,
        operatorName: typeof body.operatorName === "string" ? body.operatorName : undefined,
        stockLocation: body.stockLocation === "PORTO" ? "PORTO" : "FRENTE", fuelTypeId: Number(body.fuelTypeId) || undefined,
        note: typeof body.note === "string" ? body.note.slice(0, 300) : null,
      });
      return Response.json(result);
    }
    if (body.action === "reject") return Response.json(await rejectConvoyRecord(user, id, String(body.reason ?? "")));
    if (body.action === "request_correction") return Response.json(await requestConvoyCorrection(user, id, String(body.note ?? "")));
    if (body.action === "ai_check") {
      if (!(await listConvoyRecords(user, { status: "TODOS", from: null, to: null, frontId: null, id })).length) return Response.json({ error: "Registro não encontrado." }, { status: 404 });
      const result = await checkConvoyPhoto(id, { force: true, actorId: user.id });
      if (!result) return Response.json({ error: "Conferência indisponível (sem foto, sem leitura ou Assistente JC sem chave configurada)." }, { status: 422 });
      const text = { CONFERE: "A foto confere com o número digitado.", DIVERGE: `A foto mostra ${result.reading?.toLocaleString("pt-BR")}: diverge do digitado.`, ILEGIVEL: "Não foi possível ler o número na foto.", ERRO: "A conferência falhou. Tente de novo." }[result.status];
      return Response.json({ ...result, message: text });
    }
    return Response.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message, ...error.data }, { status: error.status });
    console.error("[convoy.action]", error);
    return Response.json({ error: "Não foi possível concluir agora." }, { status: 500 });
  }
}
