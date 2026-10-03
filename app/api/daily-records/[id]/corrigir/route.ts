import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { corrigirImportado, DailyImportError, type CorrecaoImportado } from "../../../../../lib/daily-import";

type Context = { params: Promise<{ id: string }> };
const numero = (valor: unknown) => { if (valor === null || valor === undefined || valor === "") return null; if (typeof valor === "number") return Number.isFinite(valor) ? valor : null; const n = Number(String(valor).replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };

// Corrige um registro (operador um a um, leituras e "Conferir"). Precisa de "daily.manage".
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Registro inválido." }, { status: 400 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const op = body.operador as Record<string, unknown> | null | undefined;
    const input: CorrecaoImportado = {
      operador: op?.tipo === "CAMPO" ? { tipo: "CAMPO", id: Number(op.id) } : op?.tipo === "NOME" ? { tipo: "NOME", nome: String(op.nome ?? "") } : op?.tipo === "SEM" ? { tipo: "SEM" } : null,
      aplicarMesmoNome: body.aplicarMesmoNome === true, inicial: numero(body.inicial), final: numero(body.final), conferir: body.conferir === true,
    };
    const { outros, leituraAtualizada } = await corrigirImportado(auth.user!, id, input);
    return Response.json({ ok: true, message: `Registro corrigido${outros ? ` (e mais ${outros} com o mesmo nome)` : ""}.${leituraAtualizada ? " Leitura atual do equipamento atualizada." : ""}` });
  } catch (error) {
    if (error instanceof DailyImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[daily-records.corrigir]", error);
    return Response.json({ error: "Não foi possível corrigir agora." }, { status: 500 });
  }
}
