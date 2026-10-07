import { and, eq } from "drizzle-orm";
import type { getDb } from "../db";
import { fuelMovements, fuelTypes, serviceFronts } from "../db/schema";
import type { SessionUser } from "./auth";
import { isUniqueViolation, readClientRequestId } from "./client-request";
import { fuelEquipmentContext, fuelLocalDay, fuelVisibleFronts, readFuelMovementBody, readThirdPartyFuelFields, resolveFuelFront, resolveResponsible } from "./fuel";
import { validateFuelMovement } from "./fuel-rules";
import { consumptionByMovement, prepareThirdPartyFuel, refreshVehicleLastReading } from "./third-parties";

// ---------------------------------------------------------------------------
// Gravação de um lançamento de combustível — a MESMA função para o formulário "Novo Registro"
// (POST /api/fuel/movements) e para a importação por planilha (lib/fuel-import.ts): mesmas
// validações, mesmo saldo (calculado dos lançamentos), mesmas regras de terceiros (leitura, tanque,
// consumo) e o mesmo resumo de sucesso.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;

export class FuelCreateError extends Error {
  constructor(message: string, public status = 400, public data: Record<string, unknown> = {}) { super(message); }
}

export type FuelCreateOptions = {
  displayedFronts: number[] | "ALL";
  // Importação: lote gravado no lançamento e leitura de terceiro conferida pela data do abastecimento.
  importBatchId?: number | null;
  referenceByDate?: boolean;
  // "Lançar tudo" do Assistente JC; aprovação de abastecimento do comboio.
  createdVia?: "ASSISTENTE" | "COMBOIO" | null;
};

export type FuelCreateResult = { id: number; duplicate: boolean; message: string; consumption: { value: number; unit: string } | null };

export async function createFuelMovement(db: Db, user: SessionUser, body: Record<string, unknown>, options: FuelCreateOptions): Promise<FuelCreateResult> {
  const clientRequestId = readClientRequestId(body.clientRequestId);
  const alreadySent = async () => clientRequestId ? (await db.select({ id: fuelMovements.id }).from(fuelMovements).where(eq(fuelMovements.clientRequestId, clientRequestId)).limit(1))[0] ?? null : null;
  const duplicate = (id: number): FuelCreateResult => ({ id, duplicate: true, message: "Este lançamento já tinha sido registrado.", consumption: null });
  const previous = await alreadySent();
  if (previous) return duplicate(previous.id);
  const parsed = readFuelMovementBody(body);
  let input: typeof parsed;
  try { input = { ...parsed, ...(await resolveResponsible(db, parsed.responsibleEmployeeId, parsed.responsible)) }; }
  catch { throw new FuelCreateError("Funcionário responsável não encontrado."); }
  const fronts = await fuelVisibleFronts(db, user);
  const visibleIds = fronts.map((front) => front.id);
  if (visibleIds.length === 0) throw new FuelCreateError("Seu usuário não está vinculado a nenhuma frente de serviço.", 403);
  const serviceFrontId = resolveFuelFront(visibleIds, body.serviceFrontId, options.displayedFronts, user);
  if (!serviceFrontId) throw new FuelCreateError("Escolha a frente de serviço do lançamento.");
  // Filial destino pode ser qualquer frente ativa (mesmo uma que a pessoa não enxerga).
  if (input.destinationFrontId && !(await db.select({ id: serviceFronts.id }).from(serviceFronts).where(and(eq(serviceFronts.id, input.destinationFrontId), eq(serviceFronts.active, true))).limit(1))[0])
    throw new FuelCreateError("Filial destino inválida.");
  const fuelType = (await db.select({ id: fuelTypes.id }).from(fuelTypes).where(and(eq(fuelTypes.id, input.fuelTypeId), eq(fuelTypes.active, true))).limit(1))[0];
  if (!fuelType) throw new FuelCreateError("Escolha um tipo de combustível válido.");
  const equipment = input.equipmentId ? await fuelEquipmentContext(db, input.equipmentId) : null;
  // Saída para terceiro do cadastro: empresa e veículo vêm do cadastro de Terceiros (com leitura, tanque
  // cheio, capacidade do tanque e consumo conferidos); os textos livres antigos são preenchidos a partir
  // dele. Terceiro/Doações também pode ser Manual: sem cadastro, só o Destino/Descrição em texto livre
  // (conferido em validateFuelMovement). Prestadores de Serviço é sempre do cadastro.
  let thirdPartyFields: Awaited<ReturnType<typeof prepareThirdPartyFuel>> | null = null;
  const thirdFields = input.thirdParty ? readThirdPartyFuelFields(body) : null;
  if (input.thirdParty && (thirdFields!.thirdPartyId || input.thirdPartyKind === "PRESTADOR")) {
    const fields = thirdFields!;
    if (!fields.thirdPartyId) throw new FuelCreateError("Escolha a empresa no cadastro de terceiros.");
    thirdPartyFields = await prepareThirdPartyFuel(db, user, {
      ...fields, thirdPartyId: fields.thirdPartyId, mode: input.thirdPartyKind === "PRESTADOR" ? "PRESTADOR" : "GERAL", quantity: input.quantity,
      movementDate: input.movementDate, notes: input.notes, editingId: null, current: null, referenceByDate: options.referenceByDate === true,
    });
    input = { ...input, providerCompany: thirdPartyFields.providerCompany, providerEquipment: thirdPartyFields.providerEquipment, thirdPartyDescription: thirdPartyFields.thirdPartyDescription };
  }
  const problem = validateFuelMovement({ ...input, serviceFrontId }, equipment, fuelLocalDay());
  if (problem) throw new FuelCreateError(problem);
  let created: { id: number };
  try {
    const values = {
      ...input, serviceFrontId, clientRequestId, importBatchId: options.importBatchId ?? null, createdVia: options.createdVia ?? null,
      // Frente ↔ Porto da mesma frente: o destino é a própria frente.
      destinationFrontId: input.movementType === "TRANSFERENCIA" ? input.destinationFrontId ?? serviceFrontId : null,
      meterUnit: equipment && input.meterReading !== null ? (equipment.controlType === "KM" ? "KM" as const : "HOURS" as const) : null,
      createdBy: user.id,
    };
    // Terceiro: empresa, veículo ou funcionário (destino/finalidade), leitura e consumo vêm do cadastro.
    [created] = await db.insert(fuelMovements).values(thirdPartyFields ? { ...values, ...thirdPartyFields } : values).returning({ id: fuelMovements.id });
  } catch (error) {
    const again = isUniqueViolation(error) ? await alreadySent() : null;
    if (again) return duplicate(again.id);
    throw error;
  }
  await refreshVehicleLastReading(db, thirdPartyFields?.thirdPartyVehicleId);
  // Resumo para a mensagem de sucesso: quem recebeu, litros e o consumo calculado (mesma conta do Histórico).
  const vehicleId = thirdPartyFields?.thirdPartyVehicleId ?? null;
  const found = vehicleId ? (await consumptionByMovement(db, [vehicleId])).get(created.id) ?? null : null;
  const consumption = found ? { value: found.value, unit: found.unit } : null;
  const who = thirdPartyFields ? (thirdPartyFields.providerEquipment ?? thirdPartyFields.thirdPartyDescription ?? "terceiro")
    : input.thirdParty ? input.thirdPartyDescription ?? input.providerEquipment ?? "terceiro" : equipment?.prefix ?? null;
  const summary = [
    input.movementType === "ENTRADA" ? "Entrada" : input.movementType === "TRANSFERENCIA" ? "Transferência" : "Saída",
    who, `${input.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`,
    vehicleId ? consumption ? `consumo ${consumption.value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${consumption.unit}` : thirdPartyFields?.fullTank === false ? "tanque parcial (consumo no próximo tanque cheio)" : "sem consumo (primeiro tanque cheio do veículo)" : null,
  ].filter(Boolean).join(" · ");
  return { id: created.id, duplicate: false, consumption, message: `Lançamento registrado: ${summary}${thirdPartyFields?.consumptionOutlier ? " — marcado como fora da média de consumo" : ""}.` };
}
