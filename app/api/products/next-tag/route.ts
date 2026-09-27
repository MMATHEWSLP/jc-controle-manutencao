import { getDb } from "../../../../db";
import { products } from "../../../../db/schema";
import { authorize } from "../../../../lib/auth";
import { nextSequentialTag } from "../../../../lib/product-rules";

// Próxima TAG disponível na sequência (maior TAG numérica + 1). A TAG é única no sistema inteiro.
export async function GET(request: Request) {
  const auth = await authorize(request, "products.create");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const rows = await db.select({ tag: products.tag }).from(products);
    return Response.json({ tag: nextSequentialTag(rows.map((row) => row.tag)) });
  } catch (error) {
    console.error("[products.next-tag]", error);
    return Response.json({ error: "Não foi possível calcular a próxima TAG agora." }, { status: 500 });
  }
}
