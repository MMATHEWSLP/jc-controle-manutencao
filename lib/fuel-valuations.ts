import { asc } from "drizzle-orm";
import type { getDb } from "../db";
import { fuelStockValuations } from "../db/schema";
import type { FuelValuation } from "./fuel-rules";

// Reavaliações do custo do combustível em estoque (db/schema.ts:fuelStockValuations), para
// computeFuelCosts. Antes da migração 0050 a tabela não existe: sem reavaliação.
export async function loadFuelValuations(db: Awaited<ReturnType<typeof getDb>>): Promise<FuelValuation[]> {
  try {
    return await db.select({
      id: fuelStockValuations.id, fuelTypeId: fuelStockValuations.fuelTypeId, serviceFrontId: fuelStockValuations.serviceFrontId,
      stockLocation: fuelStockValuations.stockLocation, effectiveDate: fuelStockValuations.effectiveDate, unitCost: fuelStockValuations.unitCost,
    }).from(fuelStockValuations).orderBy(asc(fuelStockValuations.effectiveDate), asc(fuelStockValuations.id));
  } catch (error) {
    if ((error as { cause?: { code?: string } })?.cause?.code === "42P01") return [];
    throw error;
  }
}
