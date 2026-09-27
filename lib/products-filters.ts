// Filtros compartilhados entre GET /api/products, /api/products-csv e /api/products-pdf, para que
// "exportar" sempre reflita exatamente os mesmos critérios usados na tela (busca ampla, TAG exata,
// aplicação, fornecedor, marca, somente pendentes de revisão e frente em exibição).
import { and, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { products } from "../db/schema";
import { normalizeReference } from "./product-rules";

function clean(value: string | null) {
  return (value ?? "").trim();
}

function idList(ids: number[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`,`);
}

// Produto ativo em alguma das frentes informadas (estoque por frente, product_front_stock).
export function activeInFrontsSql(fronts: number[]): SQL {
  if (fronts.length === 0) return sql`FALSE`;
  return sql`EXISTS (SELECT 1 FROM product_front_stock pfs WHERE pfs.product_id=${products.id} AND pfs.active=TRUE AND pfs.service_front_id IN (${idList(fronts)}))`;
}

export function activeInAnyFrontSql(): SQL {
  return sql`EXISTS (SELECT 1 FROM product_front_stock pfs WHERE pfs.product_id=${products.id} AND pfs.active=TRUE)`;
}

// `displayed` = frentes em exibição (lib/active-front.ts). Por padrão só entram produtos ATIVOS
// nessas frentes; com ?includeInactive=1 entram também os que existem só em outras frentes (a tela
// mostra esses apagados, com o botão "Ativar nesta frente").
export function buildProductWhere(url: URL, displayed: number[] | "ALL" = "ALL"): SQL | undefined {
  const q = clean(url.searchParams.get("q"));
  const exactTag = clean(url.searchParams.get("tag"));
  const equipmentModelParam = url.searchParams.get("equipmentModelId");
  const supplierParam = url.searchParams.get("supplierId");
  const brandParam = clean(url.searchParams.get("brand"));
  const onlyNeedsReview = url.searchParams.get("needsReview") === "1";
  const includeInactive = url.searchParams.get("includeInactive") === "1";

  const conditions: (SQL | undefined)[] = [eq(products.active, true)];
  if (q) {
    const reference = normalizeReference(q);
    conditions.push(or(
      ilike(products.tag, `%${q}%`),
      ilike(products.name, `%${q}%`),
      ilike(products.reference, `%${q}%`),
      reference ? sql`EXISTS (SELECT 1 FROM product_references pr WHERE pr.product_id=${products.id} AND pr.normalized LIKE ${`%${reference}%`})` : undefined,
    ));
  }
  // Segunda lupa: TAG idêntica (só ignora maiúsculas/minúsculas e espaços nas pontas).
  if (exactTag) conditions.push(sql`upper(${products.tag})=${exactTag.toUpperCase()}`);
  if (equipmentModelParam === "none") conditions.push(sql`NOT EXISTS (SELECT 1 FROM product_equipment_models pem WHERE pem.product_id=${products.id})`);
  else if (equipmentModelParam && Number(equipmentModelParam) > 0) conditions.push(sql`EXISTS (SELECT 1 FROM product_equipment_models pem WHERE pem.product_id=${products.id} AND pem.equipment_model_id=${Number(equipmentModelParam)})`);
  if (supplierParam) conditions.push(eq(products.supplierId, Number(supplierParam)));
  if (brandParam) conditions.push(ilike(products.brand, brandParam));
  if (onlyNeedsReview) conditions.push(eq(products.needsReview, true));
  if (!includeInactive && displayed !== "ALL") conditions.push(activeInFrontsSql(displayed));
  return and(...conditions.filter((condition): condition is SQL => Boolean(condition)));
}

export function describeProductFilters(url: URL, frontLabel?: string): string {
  const parts: string[] = [];
  if (frontLabel) parts.push(`Frente: ${frontLabel}`);
  const q = clean(url.searchParams.get("q"));
  if (q) parts.push(`Busca: "${q}"`);
  const tag = clean(url.searchParams.get("tag"));
  if (tag) parts.push(`TAG exata: ${tag}`);
  if (url.searchParams.get("equipmentModelId") === "none") parts.push("Aplicação: uso geral");
  else if (url.searchParams.get("equipmentModelId")) parts.push("Aplicação filtrada");
  if (url.searchParams.get("supplierId")) parts.push("Fornecedor filtrado");
  const brand = clean(url.searchParams.get("brand"));
  if (brand) parts.push(`Marca: ${brand}`);
  if (url.searchParams.get("needsReview") === "1") parts.push("Somente pendentes de revisão");
  return parts.length ? parts.join(" · ") : "Todos os produtos ativos";
}
