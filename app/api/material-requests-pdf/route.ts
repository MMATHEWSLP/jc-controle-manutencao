import { authorize } from "../../../lib/auth";
import { createMaterialRequestPdf, createMaterialShipmentPdf, formatPdfDate } from "../../../lib/pdf";
import { canSeeAllRequests, loadRequests } from "../material-requests/route";

function safeFilename(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-"); }

export async function GET(request: Request) {
  const auth = await authorize(request, "materials.view"); if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    const kind = url.searchParams.get("kind") === "SHIPMENT" ? "SHIPMENT" : "REQUEST";
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Informe uma solicitação válida para exportar." }, { status: 400 });
    const found = (await loadRequests(id))[0];
    if (!found) return Response.json({ error: "Solicitação não encontrada." }, { status: 404 });
    if (found.requesterId !== auth.user!.id && !canSeeAllRequests(auth.user!)) return Response.json({ error: "Você não possui acesso a esta solicitação." }, { status: 403 });
    if (kind === "SHIPMENT" && !["SENT", "PARTIALLY_SENT", "NOT_FULFILLED"].includes(found.status)) return Response.json({ error: "Esta solicitação ainda não teve o envio confirmado pelo almoxarifado." }, { status: 400 });

    const base = {
      requestNumber: found.requestNumber, requester: found.requester, serviceFront: found.serviceFront,
      requestedAt: formatPdfDate(found.requestedAt), statusLabel: found.statusLabel, notes: found.notes || "Sem observações.",
      items: found.items.map((item) => ({ description: item.description, quantityRequested: item.quantityRequested, reference: item.reference, itemStatus: item.itemStatus, quantitySent: item.quantitySent })),
      generatedAt: formatPdfDate(new Date().toISOString()),
    };
    const pdf = kind === "SHIPMENT"
      ? createMaterialShipmentPdf({ ...base, shippedBy: found.shippedByName ?? "Não informado", shippedAt: found.shippedAt ? formatPdfDate(found.shippedAt) : "—", shipmentNotes: found.shipmentNotes || "Sem observações." })
      : createMaterialRequestPdf(base);
    const filename = `${kind === "SHIPMENT" ? "envio" : "solicitacao"}-materiais-${safeFilename(found.requestNumber)}.pdf`;
    return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[material-requests-pdf.get]", error);
    return Response.json({ error: "Não foi possível gerar o PDF desta solicitação." }, { status: 500 });
  }
}
