import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { deleteOtherExpense, otherExpenseErrorResponse, updateOtherExpense } from "../../../../lib/other-expenses";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "costs.other_expenses");
  if (auth.response) return auth.response;
  try {
    await updateOtherExpense(await getDb(), auth.user!, Number((await context.params).id), await request.json() as Record<string, unknown>);
    return Response.json({ message: "Gasto alterado." });
  } catch (error) {
    const known = otherExpenseErrorResponse(error); if (known) return known;
    console.error("[other-expenses.put]", error);
    return Response.json({ error: "Não foi possível alterar o gasto agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "costs.other_expenses");
  if (auth.response) return auth.response;
  try {
    await deleteOtherExpense(await getDb(), auth.user!, Number((await context.params).id));
    return Response.json({ message: "Gasto excluído." });
  } catch (error) {
    const known = otherExpenseErrorResponse(error); if (known) return known;
    console.error("[other-expenses.delete]", error);
    return Response.json({ error: "Não foi possível excluir o gasto agora." }, { status: 500 });
  }
}
