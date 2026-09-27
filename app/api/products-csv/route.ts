import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { products, suppliers } from "../../../db/schema";
import { frentesEmExibicao } from "../../../lib/active-front";
import { authorize } from "../../../lib/auth";
import { loadProductExtras, scopeSummary } from "../../../lib/products-data";
import { buildProductWhere } from "../../../lib/products-filters";

function csvCell(value: string) {
  return /[";\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const displayed = frentesEmExibicao(auth.user!, request);
    const where = buildProductWhere(url, displayed);
    const db = await getDb();
    const rows = await db
      .select({
        id: products.id,
        tag: products.tag,
        name: products.name,
        reference: products.reference,
        price: products.price,
        supplierName: suppliers.name,
        brand: products.brand,
      })
      .from(products)
      .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
      .where(where)
      .orderBy(asc(products.tag));
    const extras = await loadProductExtras(db, rows.map((row) => row.id), auth.user!);

    // As 7 primeiras colunas seguem o layout aceito pela importação (tag;nome;...;aplicacao).
    const header = ["tag", "nome", "referencia", "preco", "fornecedor", "marca", "aplicacao", "estoque", "estoque_por_frente"].join(";");
    const lines = rows.map((row) => {
      const extra = extras.get(row.id)!;
      const byFront = extra.fronts.filter((front) => front.active && front.quantity !== null).map((front) => `${front.name}: ${front.quantity}`).join(" | ");
      return [row.tag, row.name, row.reference ?? "", row.price.toFixed(2), row.supplierName ?? "", row.brand ?? "", extra.applicationNames.join(", "), String(scopeSummary(extra.fronts, displayed).quantityHere).replace(".", ","), byFront]
        .map((value) => csvCell(String(value)))
        .join(";");
    });
    const csv = `﻿${[header, ...lines].join("\r\n")}\r\n`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="produtos.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[products-csv.get]", error);
    return Response.json({ error: "Não foi possível exportar os produtos agora." }, { status: 500 });
  }
}
