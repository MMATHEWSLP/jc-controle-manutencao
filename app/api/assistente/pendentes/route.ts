import { listarPendentes, removerPendentes } from "../../../../lib/assistente/pendentes";
import { contextoPendentes, erroPendentes } from "./acesso";

// Lista "Lançamentos pendentes" do usuário, com o status de cada item calculado agora.
export async function GET(request: Request) {
  const { ctx, response } = await contextoPendentes(request, false);
  if (response) return response;
  try { return Response.json(await listarPendentes(ctx)); }
  catch (error) { return erroPendentes(error, "listar"); }
}

// "Limpar lista": remove todos os itens pendentes (nada gravado no sistema é desfeito).
export async function DELETE(request: Request) {
  const { ctx, response } = await contextoPendentes(request, true);
  if (response) return response;
  try { return Response.json(await removerPendentes(ctx, "TODOS")); }
  catch (error) { return erroPendentes(error, "limpar"); }
}
