import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { equipmentModels, products, suppliers } from "../../../db/schema";
import { authorize } from "../../../lib/auth";
import { buildProductWhere, describeProductFilters } from "../../../lib/products-filters";
import { createProductsListPdf, formatPdfDate } from "../../../lib/pdf";

export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const where = buildProductWhere(url);
    const db = await getDb();
    const rows = await db
      .select({
        tag: products.tag,
        name: products.name,
        reference: products.reference,
        price: products.price,
        supplierName: suppliers.name,
        applicationName: equipmentModels.name,
        needsReview: products.needsReview,
      })
      .from(products)
      .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
      .leftJoin(equipmentModels, eq(products.equipmentModelId, equipmentModels.id))
      .where(where)
      .orderBy(asc(products.tag));

    const pdf = createProductsListPdf({
      items: rows.map((row) => ({
        tag: row.tag,
        name: row.name,
        reference: row.reference ?? "",
        price: row.price,
        supplier: row.supplierName ?? "",
        application: row.applicationName ?? "",
        needsReview: row.needsReview,
      })),
      total: rows.length,
      generatedAt: formatPdfDate(new Date().toISOString()),
      filters: describeProductFilters(url),
    });
    return new Response(pdf, {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="produtos.pdf"`, "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[products-pdf.get]", error);
    return Response.json({ error: "Não foi possível gerar o PDF de produtos agora." }, { status: 500 });
  }
}
