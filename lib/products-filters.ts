// Filtros compartilhados entre GET /api/products, /api/products-csv e /api/products-pdf, para que
// "exportar" sempre reflita exatamente os mesmos critérios usados na tela (busca, aplicação,
// fornecedor, marca, somente pendentes de revisão).
import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { products } from "../db/schema";

function clean(value: string | null) {
  return (value ?? "").trim();
}

export function buildProductWhere(url: URL): SQL | undefined {
  const q = clean(url.searchParams.get("q"));
  const equipmentModelParam = url.searchParams.get("equipmentModelId");
  const supplierParam = url.searchParams.get("supplierId");
  const brandParam = clean(url.searchParams.get("brand"));
  const onlyNeedsReview = url.searchParams.get("needsReview") === "1";

  const conditions: (SQL | undefined)[] = [eq(products.active, true)];
  if (q) conditions.push(or(ilike(products.tag, `%${q}%`), ilike(products.name, `%${q}%`), ilike(products.reference, `%${q}%`)));
  if (equipmentModelParam === "none") conditions.push(isNull(products.equipmentModelId));
  else if (equipmentModelParam) conditions.push(eq(products.equipmentModelId, Number(equipmentModelParam)));
  if (supplierParam) conditions.push(eq(products.supplierId, Number(supplierParam)));
  if (brandParam) conditions.push(ilike(products.brand, brandParam));
  if (onlyNeedsReview) conditions.push(eq(products.needsReview, true));
  return and(...conditions.filter((condition): condition is SQL => Boolean(condition)));
}

export function describeProductFilters(url: URL): string {
  const parts: string[] = [];
  const q = clean(url.searchParams.get("q"));
  if (q) parts.push(`Busca: "${q}"`);
  if (url.searchParams.get("equipmentModelId") === "none") parts.push("Aplicação: uso geral");
  if (url.searchParams.get("supplierId")) parts.push("Fornecedor filtrado");
  const brand = clean(url.searchParams.get("brand"));
  if (brand) parts.push(`Marca: ${brand}`);
  if (url.searchParams.get("needsReview") === "1") parts.push("Somente pendentes de revisão");
  return parts.length ? parts.join(" · ") : "Todos os produtos ativos";
}
