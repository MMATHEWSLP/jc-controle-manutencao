import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { equipmentModels, products, suppliers } from "../../../db/schema";
import { authorize } from "../../../lib/auth";
import { buildProductWhere } from "../../../lib/products-filters";

function csvCell(value: string) {
  return /[";\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

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
        brand: products.brand,
        applicationName: equipmentModels.name,
      })
      .from(products)
      .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
      .leftJoin(equipmentModels, eq(products.equipmentModelId, equipmentModels.id))
      .where(where)
      .orderBy(asc(products.tag));

    const header = ["tag", "nome", "referencia", "preco", "fornecedor", "marca", "aplicacao"].join(";");
    const lines = rows.map((row) =>
      [row.tag, row.name, row.reference ?? "", row.price.toFixed(2), row.supplierName ?? "", row.brand ?? "", row.applicationName ?? ""]
        .map((value) => csvCell(String(value)))
        .join(";")
    );
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
