import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { products, serviceFronts, suppliers } from "../../../db/schema";
import { frentesEmExibicao } from "../../../lib/active-front";
import { authorize } from "../../../lib/auth";
import { loadProductExtras, scopeSummary } from "../../../lib/products-data";
import { buildProductWhere, describeProductFilters } from "../../../lib/products-filters";
import { createProductsListPdf, formatPdfDate } from "../../../lib/pdf";

export async function GET(request: Request) {
  // Também RELATÓRIOS → Peças e produtos (reports.pecas).
  const auth = await authorize(request, ["products.view", "reports.pecas"]);
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const displayed = frentesEmExibicao(auth.user!, request);
    const where = buildProductWhere(url, displayed);
    const db = await getDb();
    const frontLabel = displayed === "ALL" ? "Todas as frentes" : (await db.select({ name: serviceFronts.name }).from(serviceFronts).where(inArray(serviceFronts.id, displayed))).map((row) => row.name).join(", ");
    const rows = await db
      .select({
        id: products.id,
        tag: products.tag,
        name: products.name,
        reference: products.reference,
        price: products.price,
        supplierName: suppliers.name,
        needsReview: products.needsReview,
      })
      .from(products)
      .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
      .where(where)
      .orderBy(asc(products.tag));
    const extras = await loadProductExtras(db, rows.map((row) => row.id), auth.user!);

    const pdf = createProductsListPdf({
      items: rows.map((row) => ({
        stock: scopeSummary(extras.get(row.id)!.fronts, displayed).quantityHere,
        tag: row.tag,
        name: row.name,
        reference: row.reference ?? "",
        price: row.price,
        supplier: row.supplierName ?? "",
        application: extras.get(row.id)!.applicationNames.join(", "),
        needsReview: row.needsReview,
      })),
      total: rows.length,
      generatedAt: formatPdfDate(new Date().toISOString()),
      filters: describeProductFilters(url, frontLabel),
    });
    return new Response(pdf, {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="produtos.pdf"`, "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[products-pdf.get]", error);
    return Response.json({ error: "Não foi possível gerar o PDF de produtos agora." }, { status: 500 });
  }
}
