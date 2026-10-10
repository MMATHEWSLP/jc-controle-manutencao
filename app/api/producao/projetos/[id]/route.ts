import { changeStage, ProductionError, setProjectActive, setStageNotes, updateProject } from "../../../../../lib/production";
import { productionRoute, readBody, routeId } from "../../../../../lib/production-api";
import { STAGE_STATUS_LABELS } from "../../../../../lib/production-rules";

type Context = { params: Promise<{ id: string }> };

// Uma rota para as ações do projeto: editar, inativar/reativar, observação da etapa e finalizar/reabrir etapa.
export async function PATCH(request: Request, context: Context) {
  return productionRoute(request, "projetos.patch", async ({ db, user, fronts }) => {
    const id = await routeId(context);
    const body = await readBody(request);
    switch (body.acao) {
      case "editar": await updateProject(db, user, fronts, id, body); return Response.json({ message: "Projeto alterado." });
      case "inativar": await setProjectActive(db, user, fronts, id, false); return Response.json({ message: "Projeto inativado." });
      case "reativar": await setProjectActive(db, user, fronts, id, true); return Response.json({ message: "Projeto reativado." });
      case "observacao": await setStageNotes(db, user, fronts, id, body.etapa, body.observacao); return Response.json({ message: "Observação salva." });
      case "etapa": {
        const status = await changeStage(db, user, fronts, id, body.etapa, body.etapaAcao, body.nota);
        return Response.json({ status, message: `Etapa ${status === "FINALIZADO" ? "finalizada" : `reaberta (${STAGE_STATUS_LABELS[status].toLowerCase()})`}.` });
      }
      default: throw new ProductionError("Ação inválida.");
    }
  }, { write: true });
}
