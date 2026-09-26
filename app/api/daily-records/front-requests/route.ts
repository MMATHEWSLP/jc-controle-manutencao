import { authorize } from "../../../../lib/auth";
import { countPendingFrontRequests, listFrontRequests } from "../../../../lib/front-requests";

// ?count=1 devolve só o número de pendências (contador do menu).
export async function GET(request: Request) {
  const auth = await authorize(request, "daily.front_requests"); if (auth.response) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    if (params.get("count")) return Response.json({ pending: await countPendingFrontRequests(auth.user!) });
    return Response.json({ requests: await listFrontRequests(auth.user!, params.get("status") === "ALL" ? "ALL" : "PENDING") });
  } catch (error) {
    console.error("[front-requests.get]", error);
    return Response.json({ error: "Não foi possível carregar as solicitações." }, { status: 500 });
  }
}
