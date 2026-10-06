import { authorize } from "../../../../../lib/auth";
import { canApproveConvoy, pendingConvoyCount } from "../../../../../lib/convoy";

// Contador do menu: abastecimentos do comboio pendentes de aprovação nas frentes de quem aprova.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  if (!canApproveConvoy(auth.user!)) return Response.json({ pending: 0 });
  try { return Response.json({ pending: await pendingConvoyCount(auth.user!) }); }
  catch (error) { console.error("[convoy.count]", error); return Response.json({ pending: 0 }); }
}
