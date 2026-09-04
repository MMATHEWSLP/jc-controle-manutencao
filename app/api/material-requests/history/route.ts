import { authorize } from "../../../../lib/auth";
import { getDb } from "../../../../db";
import { serviceFronts } from "../../../../db/schema";
import { asc } from "drizzle-orm";
import { TERMINAL_STATUSES, canSeeAllRequests, loadRequests } from "../route";

function clean(value: string | null) { return (value ?? "").trim(); }

// Histórico de Solicitações de Materiais (seção 11): só solicitações terminais (finalizadas,
// recusadas/não atendidas, canceladas). Um usuário comum só vê as solicitações em que ele mesmo
// foi o solicitante; quem gerencia/separa (materials.manage/materials.ship) vê todas e pode
// filtrar por frente. Nenhuma solicitação de outra frente/solicitante é acessível por aqui sem
// essa permissão.
export async function GET(request: Request) {
  const auth = await authorize(request, "materials.view"); if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const q = clean(url.searchParams.get("q")).toLocaleLowerCase("pt-BR");
    const status = clean(url.searchParams.get("status"));
    const frontId = Number(url.searchParams.get("frontId"));
    const responsibleId = Number(url.searchParams.get("responsibleId"));
    const from = clean(url.searchParams.get("from"));
    const to = clean(url.searchParams.get("to"));

    const all = await loadRequests();
    const seeAll = canSeeAllRequests(auth.user!);
    const authorized = seeAll ? all : all.filter((row) => row.requesterId === auth.user!.id);
    const terminal = authorized.filter((row) => (TERMINAL_STATUSES as string[]).includes(row.status));

    const filtered = terminal.filter((row) => {
      if (status && row.status !== status) return false;
      if (Number.isInteger(frontId) && frontId > 0 && row.serviceFrontId !== frontId) return false;
      if (Number.isInteger(responsibleId) && responsibleId > 0) {
        const responsible = row.shippedBy ?? row.cancelledBy ?? row.reopenedBy;
        if (responsible !== responsibleId) return false;
      }
      const referenceDate = (row.shippedAt ?? row.cancelledAt ?? row.requestedAt).slice(0, 10);
      if (from && referenceDate < from) return false;
      if (to && referenceDate > to) return false;
      if (q) {
        const haystack = `${row.requestNumber} ${row.requester} ${row.serviceFront} ${row.items.map((item) => item.description).join(" ")}`.toLocaleLowerCase("pt-BR");
        if (!haystack.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.shippedAt ?? b.cancelledAt ?? b.requestedAt).localeCompare(a.shippedAt ?? a.cancelledAt ?? a.requestedAt));

    const fronts = seeAll ? await (await getDb()).select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).orderBy(asc(serviceFronts.name)) : [];
    return Response.json({ requests: filtered, fronts, canManage: seeAll });
  } catch (error) {
    console.error("[material-requests.history.get]", error);
    return Response.json({ error: "Não foi possível carregar o histórico de solicitações de materiais." }, { status: 500 });
  }
}
