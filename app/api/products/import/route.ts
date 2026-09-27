import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { equipmentModels, productEquipmentModels, products, suppliers } from "../../../../db/schema";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { parseReferenceList } from "../../../../lib/product-rules";
import { activateInFront, activeFrontList, replaceReferences } from "../../../../lib/products-data";
import { GARBAGE_TAGS, generalNeedsReview, isGenericApplication, matchEquipmentModel, parsePrice, parseProductsCsv } from "../../../../lib/products-import";

// Rota da tela "Importar CSV" (botão em Produtos, ADMIN via products.import). Diferente do script
// scripts/import-produtos.ts (que reimporta a base histórica tratada e usa a aba "Revisar" da
// planilha original), esta rota aceita qualquer CSV no mesmo formato e aplica a regra geral da
// seção 3 da especificação: aplicação "(modelo a definir)" ou preço 0 marcam needs_review; se o
// CSV trouxer fornecedor/marca preenchidos desta vez, eles são aproveitados (fornecedor é casado
// por nome, criando um novo cadastro quando não existir).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.import");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as { csv?: unknown };
    const content = typeof body.csv === "string" ? body.csv : "";
    if (!content.trim()) return Response.json({ error: "Envie o conteúdo do arquivo CSV." }, { status: 400 });

    const rows = parseProductsCsv(content);
    if (rows.length === 0) return Response.json({ error: "Nenhuma linha encontrada no arquivo." }, { status: 400 });

    const db = await getDb();
    const models = await db.select({ id: equipmentModels.id, name: equipmentModels.name }).from(equipmentModels);
    // Produto NOVO vindo do CSV nasce ativo nas frentes em exibição (todas, se "Todas as frentes").
    const displayed = frentesEmExibicao(auth.user!, request);
    const creationFronts = displayed === "ALL" ? (await activeFrontList(db)).map((front) => front.id) : displayed;

    let skippedGarbage = 0;
    let inserted = 0;
    let updated = 0;
    let linkedToModel = 0;
    let markedNeedsReview = 0;
    const unmatchedApplications = new Map<string, number>();
    const supplierIdByName = new Map<string, number>();

    await db.transaction(async (tx) => {
      for (const row of rows) {
        if (GARBAGE_TAGS.has(row.tag) || !row.tag) {
          skippedGarbage++;
          continue;
        }

        const price = parsePrice(row.preco) ?? 0;
        const name = row.nome.toUpperCase();
        const references = parseReferenceList(row.referencia);
        const brand = row.marca || null;

        let supplierId: number | null = null;
        if (row.fornecedor) {
          const key = row.fornecedor.toUpperCase();
          supplierId = supplierIdByName.get(key) ?? null;
          if (!supplierId) {
            const existingSupplier = (await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, row.fornecedor)).limit(1))[0];
            const supplierRow = existingSupplier ?? (await tx.insert(suppliers).values({ name: row.fornecedor }).returning({ id: suppliers.id }))[0];
            supplierId = supplierRow.id;
            supplierIdByName.set(key, supplierId);
          }
        }

        // A exportação junta várias aplicações com ", " — cada uma é casada separadamente.
        const matchedModelIds: number[] = [];
        const generic = isGenericApplication(row.aplicacao);
        if (row.aplicacao && !generic) {
          for (const application of row.aplicacao.split(/,\s+/).map((item) => item.trim()).filter(Boolean)) {
            const match = matchEquipmentModel(application, models);
            if (match) {
              if (!matchedModelIds.includes(match.id)) matchedModelIds.push(match.id);
            } else {
              unmatchedApplications.set(application, (unmatchedApplications.get(application) ?? 0) + 1);
            }
          }
          if (matchedModelIds.length) linkedToModel++;
        }
        const equipmentModelId = matchedModelIds[0] ?? null;

        const needsReview = generalNeedsReview({ price, applicationIsGeneric: generic });
        if (needsReview) markedNeedsReview++;

        const now = new Date().toISOString();
        const existing = await tx.select({ id: products.id }).from(products).where(eq(products.tag, row.tag)).limit(1);
        const [saved] = await tx
          .insert(products)
          .values({ tag: row.tag, name, price, supplierId, brand, equipmentModelId, needsReview, updatedAt: now })
          .onConflictDoUpdate({
            target: products.tag,
            set: { name, price, supplierId, brand, needsReview, updatedAt: now },
          })
          .returning({ id: products.id });
        await replaceReferences(tx, saved.id, references);
        // Aplicações do CSV são somadas às já cadastradas (o multi-select manual não é apagado).
        if (matchedModelIds.length) {
          await tx.insert(productEquipmentModels).values(matchedModelIds.map((modelId) => ({ productId: saved.id, equipmentModelId: modelId }))).onConflictDoNothing();
          await tx.update(products).set({ equipmentModelId: sql`coalesce(${products.equipmentModelId}, ${matchedModelIds[0]})` }).where(eq(products.id, saved.id));
        }
        if (existing.length === 0) for (const frontId of creationFronts) await activateInFront(tx, saved.id, frontId, auth.user!.id);
        if (existing.length > 0) updated++;
        else inserted++;
      }
    });

    return Response.json({
      totalRead: rows.length,
      skippedGarbage,
      inserted,
      updated,
      linkedToModel,
      markedNeedsReview,
      unmatchedApplications: [...unmatchedApplications.entries()].map(([application, occurrences]) => ({ application, occurrences })),
    });
  } catch (error) {
    console.error("[products.import]", error);
    return Response.json({ error: "Não foi possível importar o arquivo agora." }, { status: 500 });
  }
}
