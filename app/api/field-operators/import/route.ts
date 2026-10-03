import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { confirmFieldImport, FieldOperatorError, previewFieldImport, type AjustesImportacao } from "../../../../lib/field-operators";

const MAX_BYTES = 5 * 1024 * 1024;

// Importar funcionários de campo (só ADMIN). FormData: arquivo (.xlsx), ajustes (JSON: nomes
// corrigidos, linhas "Conferir" aprovadas e decisões dos parecidos) e confirmar=1 para gravar.
// Sem confirmar é só prévia. Os PINs nunca voltam na resposta.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const form = await request.formData();
    const arquivo = form.get("arquivo");
    if (!(arquivo instanceof File) || !arquivo.size) return Response.json({ error: "Escolha a planilha .xlsx." }, { status: 400 });
    if (arquivo.size > MAX_BYTES) return Response.json({ error: "Planilha grande demais (máximo 5 MB)." }, { status: 400 });
    const bruto = JSON.parse(String(form.get("ajustes") ?? "{}")) as Partial<AjustesImportacao>;
    const ajustes: AjustesImportacao = {
      nomes: bruto.nomes && typeof bruto.nomes === "object" ? Object.fromEntries(Object.entries(bruto.nomes).filter(([, valor]) => typeof valor === "string").map(([chave, valor]) => [chave, String(valor).slice(0, 120)])) : {},
      aprovados: Array.isArray(bruto.aprovados) ? bruto.aprovados.map(Number).filter(Number.isInteger) : [],
      decisoes: Array.isArray(bruto.decisoes) ? bruto.decisoes.filter((item) => item && Number.isInteger(Number(item.linha)) && ["VINCULAR", "MANTER", "NOVO", "IGNORAR"].includes(item.acao))
        .map((item) => ({ linha: Number(item.linha), acao: item.acao, id: Number(item.id) || undefined })) : [],
    };
    const buffer = await arquivo.arrayBuffer();
    if (form.get("confirmar") === "1") {
      const resultado = await confirmFieldImport(auth.user!, buffer, ajustes);
      return Response.json({ resultado, message: `Importação concluída: ${resultado.criados.length} criado(s), ${resultado.mantidos.length} mantido(s), ${resultado.ignorados.length} ignorado(s).` });
    }
    return Response.json(await previewFieldImport(auth.user!, buffer, ajustes));
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[field-operators.import]", error instanceof Error ? error.message : "erro");
    return Response.json({ error: "Não foi possível importar a planilha." }, { status: 500 });
  }
}
