import { and, desc, eq, inArray } from "drizzle-orm";
import { getD1, getDb } from "../../../db";
import { alerts, equipment, equipmentMaintenanceTypes, maintenancePlans, maintenanceTypes, serviceFronts } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { activeServiceFronts, allowedEquipmentIds, equipmentAccessResponse, requireEquipmentAccess } from "../../../lib/front-scope";
import { canonicalEquipmentPrefix, reconcileEquipmentMeasurement } from "../../../lib/maintenance-history";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";

type ControlType = "HOURS" | "KM" | "HOURS_KM";
type EquipmentStatus = "ACTIVE" | "STOPPED" | "MAINTENANCE" | "INACTIVE";
type IdentificationType = "SERIAL_NUMBER" | "CHASSIS";

const controlToClient: Record<ControlType, ControlType> = { HOURS:"HOURS", KM:"KM", HOURS_KM:"HOURS_KM" };
const statusToClient: Record<EquipmentStatus, string> = { ACTIVE:"Ativo", STOPPED:"Parado", MAINTENANCE:"Em manutenção", INACTIVE:"Inativo" };
const initialApplicability:Record<string,string[]>={
  PC:["TROCA DE ÓLEO DA TRANSMISSÃO","TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO","TROCA DE ÓLEO DO MOTOR","TROCA DE ÓLEO HIDRÁULICO"],
  CM:["TROCA DE ÓLEO DA CAIXA DE MARCHA","TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO","TROCA DE ÓLEO DO MOTOR"],
};

type EquipmentRow = {
  id:number; code:string; prefix:string; type:string; brand:string; model:string; year:number | null;
  serialNumber:string | null; chassis:string | null; identificationType:IdentificationType; plate:string | null;
  serviceFrontId:number | null; front:string | null; currentHours:number; currentKm:number; controlType:ControlType; status:EquipmentStatus; qrToken:string | null; oilChangeEnabled:boolean; notes:string | null;
};

function normalize(row:EquipmentRow, applicableMaintenanceTypes:string[] = []) {
  const reading = row.controlType === "KM"
    ? `${row.currentKm.toLocaleString("pt-BR")} km`
    : row.controlType === "HOURS_KM"
      ? `${row.currentHours.toLocaleString("pt-BR")} h · ${row.currentKm.toLocaleString("pt-BR")} km`
      : `${row.currentHours.toLocaleString("pt-BR")} h`;
  const identificationValue = row.identificationType === "CHASSIS" ? row.chassis : row.serialNumber;
  return {
    id:row.id, code:row.code, prefix:row.prefix, type:row.type, brand:row.brand, model:row.model,
    year:row.year ?? new Date().getFullYear(), identificationType:row.identificationType,
    identificationValue:identificationValue || "Não informado", serial:row.serialNumber || "", chassis:row.chassis || undefined,
    plate:row.plate || undefined, front:row.front || "Sem frente", reading, hours:row.currentHours, km:row.currentKm,
    serviceFrontId:row.serviceFrontId,oilChangeEnabled:row.oilChangeEnabled,notes:row.notes,
    control:controlToClient[row.controlType], applicableMaintenanceTypes, plans:applicableMaintenanceTypes.length,
    status:statusToClient[row.status], health:100, persisted:true, qrToken:row.qrToken,
  };
}

function clean(value:unknown) { return typeof value === "string" ? value.trim() : ""; }
function readApplicableTypes(value:unknown) {
  return Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : [];
}

async function getEquipmentRows() {
  const db = await getDb();
  return db.select({
    id:equipment.id, code:equipment.code, prefix:equipment.prefix, type:equipment.type, brand:equipment.brand,
    model:equipment.model, year:equipment.year, serialNumber:equipment.serialNumber, chassis:equipment.chassis,
    identificationType:equipment.identificationType, plate:equipment.plate, serviceFrontId:equipment.serviceFrontId, front:serviceFronts.name,
    currentHours:equipment.currentHours, currentKm:equipment.currentKm, controlType:equipment.controlType, status:equipment.status, qrToken:equipment.qrToken,oilChangeEnabled:equipment.oilChangeEnabled,notes:equipment.notes,
  }).from(equipment).leftJoin(serviceFronts, eq(equipment.serviceFrontId, serviceFronts.id)).orderBy(desc(equipment.id));
}

async function getApplicableMap() {
  const db = await getDb();
  const rows = await db.select({ equipmentId:equipmentMaintenanceTypes.equipmentId, name:maintenanceTypes.name })
    .from(equipmentMaintenanceTypes)
    .innerJoin(maintenanceTypes, eq(equipmentMaintenanceTypes.maintenanceTypeId, maintenanceTypes.id))
    .where(and(eq(equipmentMaintenanceTypes.applicable, true),eq(maintenanceTypes.active,true),eq(maintenanceTypes.category,"OIL")));
  return rows.reduce<Record<number,string[]>>((map,row)=>{ (map[row.equipmentId] ??= []).push(row.name); return map; },{});
}

export async function GET(request:Request) {
  const auth=await authorize(request,"equipment.view");if(auth.response)return auth.response;
  try {
    const db = await getDb();const d1=await getD1();const mode=new URL(request.url).searchParams.get("scope")==="oil"?"OIL":"MANAGEMENT";
    const [rows, applicableMap, typeRows,fronts,allowed] = await Promise.all([
      getEquipmentRows(), getApplicableMap(),
      db.select({ name:maintenanceTypes.name, category:maintenanceTypes.category }).from(maintenanceTypes).where(and(eq(maintenanceTypes.active, true),eq(maintenanceTypes.category,"OIL"))).orderBy(maintenanceTypes.name),
      activeServiceFronts(d1),allowedEquipmentIds(d1,auth.user!,mode),
    ]);
    return Response.json({
      equipment:rows.filter((row)=>allowed.has(row.id)).map((row)=>normalize(row,applicableMap[row.id] ?? [])),
      maintenanceTypes:typeRows.map((row)=>row.name),
      fronts,
    });
  } catch (error) {
    const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const message = error instanceof Error ? `${error.message} ${detail}` : "";
    return Response.json({ error:message.includes("no such table") ? "O banco de equipamentos ainda está sendo preparado." : "Não foi possível carregar os equipamentos agora." }, { status:500 });
  }
}

async function saveEquipment(request:Request, editing:boolean) {
  if(!assertSameOrigin(request))return Response.json({ error:"Origem da solicitação não autorizada." }, { status:403 });
  const auth=await authorize(request,editing?"equipment.edit":"equipment.create");if(auth.response)return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const prefix = canonicalEquipmentPrefix(body.prefix);
    const originalPrefix = canonicalEquipmentPrefix(body.originalPrefix);
    const type = clean(body.type); const brand = clean(body.brand); const model = clean(body.model);
    const requestedControlType = clean(body.controlType) as ControlType;
    const status = clean(body.status) as EquipmentStatus;
    const identificationType = clean(body.identificationType) as IdentificationType;
    let applicableNames = readApplicableTypes(body.applicableMaintenanceTypes);

    if (!prefix || !type || !brand || !model) return Response.json({ error:"Preencha prefixo, tipo, marca e modelo." }, { status:400 });
    if (!( ["HOURS","KM","HOURS_KM"] as string[]).includes(requestedControlType)) return Response.json({ error:"Selecione um tipo de controle válido." }, { status:400 });
    if (!( ["ACTIVE","STOPPED","MAINTENANCE","INACTIVE"] as string[]).includes(status)) return Response.json({ error:"Selecione um status válido." }, { status:400 });
    if (!( ["SERIAL_NUMBER","CHASSIS"] as string[]).includes(identificationType)) return Response.json({ error:"Selecione o tipo de identificação." }, { status:400 });
    const identificationValue = clean(body.identificationValue);
    if (!identificationValue) return Response.json({ error:`Informe ${identificationType === "CHASSIS" ? "o chassi" : "o número de série"}.` }, { status:400 });

    const currentHours = Number(body.currentHours || 0); const currentKm = Number(body.currentKm || 0);
    if (!Number.isFinite(currentHours) || currentHours < 0 || !Number.isFinite(currentKm) || currentKm < 0) return Response.json({ error:"Horímetro e quilometragem devem ser valores positivos." }, { status:400 });

    const db = await getDb();const d1=await getD1();
    const existing = editing && originalPrefix ? (await db.select().from(equipment).where(eq(equipment.prefix,originalPrefix)).limit(1))[0] : undefined;
    if(editing&&!existing)return Response.json({error:"Equipamento não encontrado."},{status:404});
    if(existing)await requireEquipmentAccess(d1,auth.user!,existing.id,"MANAGEMENT");
    const measurement=reconcileEquipmentMeasurement({
      prefix,type,controlType:requestedControlType,
      currentHours:currentHours>0?currentHours:Number(existing?.currentHours??0),
      currentKm:currentKm>0?currentKm:Number(existing?.currentKm??0),
      previousControlType:existing?.controlType??null,
    });
    if(editing&&existing&&!auth.user!.permissions.includes("equipment.applicable_types")){
      const currentTypes=await db.select({name:maintenanceTypes.name}).from(equipmentMaintenanceTypes).innerJoin(maintenanceTypes,eq(equipmentMaintenanceTypes.maintenanceTypeId,maintenanceTypes.id)).where(and(eq(equipmentMaintenanceTypes.equipmentId,existing.id),eq(equipmentMaintenanceTypes.applicable,true),eq(maintenanceTypes.active,true),eq(maintenanceTypes.category,"OIL")));
      applicableNames=currentTypes.map((row)=>row.name);
    }
    const code = existing?.code ?? `AUTO-${crypto.randomUUID()}`;
    const duplicate = await db.select({ id:equipment.id }).from(equipment).where(eq(equipment.prefix, prefix)).limit(1);
    if (duplicate[0] && duplicate[0].id!==existing?.id) return Response.json({ error:"Já existe um equipamento com este prefixo." }, { status:409 });

    const availableTypeRows = await db.select({ id:maintenanceTypes.id, name:maintenanceTypes.name, category:maintenanceTypes.category }).from(maintenanceTypes).where(and(eq(maintenanceTypes.active,true),eq(maintenanceTypes.category,"OIL")));
    const availableByName = new Map(availableTypeRows.map((row)=>[row.name,row.id]));
    if(!existing&&applicableNames.length===0)applicableNames=initialApplicability[prefix.split("-")[0]]??[];
    const unknown = applicableNames.find((name)=>!availableByName.has(name));
    if (unknown) return Response.json({ error:`O tipo de troca “${unknown}” não está disponível.` }, { status:400 });

    const requestedFrontId=Number(body.serviceFrontId);let frontId=existing?.serviceFrontId??null;
    if(!existing){
      if(!Number.isInteger(requestedFrontId)||requestedFrontId<=0)return Response.json({error:"Selecione a frente de serviço."},{status:400});
      const frontRow=await db.select({id:serviceFronts.id}).from(serviceFronts).where(and(eq(serviceFronts.id,requestedFrontId),eq(serviceFronts.active,true))).limit(1);
      if(!frontRow[0])return Response.json({error:"A frente de serviço selecionada não existe."},{status:400});
      if(auth.user!.profile!=="ADMIN"&&auth.user!.serviceFrontId!==frontRow[0].id)return Response.json({error:"Você só pode cadastrar equipamentos na sua própria frente."},{status:403});
      frontId=frontRow[0].id;
    }
    const oilChangeEnabled=body.oilChangeEnabled===undefined?(existing?.oilChangeEnabled??true):(body.oilChangeEnabled===true||body.oilChangeEnabled==="true"||body.oilChangeEnabled==="1"||body.oilChangeEnabled==="on");
    if(!existing&&!oilChangeEnabled)applicableNames=[];

    const now = new Date().toISOString();
    const values = {
      code, prefix, type, brand, model, year:Number(body.year) || null,
      serialNumber:identificationType === "SERIAL_NUMBER" ? identificationValue : existing?.serialNumber ?? (clean(body.preservedSerialNumber) || null),
      chassis:identificationType === "CHASSIS" ? identificationValue : existing?.chassis ?? (clean(body.preservedChassis) || null),
      identificationType, plate:clean(body.plate).toUpperCase() || null, serviceFrontId:frontId,
      qrToken:existing?.qrToken ?? crypto.randomUUID(),
      currentHours:measurement.currentHours,
      currentKm:measurement.currentKm,
      controlType:measurement.controlType, status, oilChangeEnabled,notes:body.notes===undefined?(existing?.notes??null):(clean(body.notes)||null), updatedAt:now,
    };
    const saved = existing
      ? (await db.update(equipment).set(values).where(eq(equipment.id,existing.id)).returning())[0]
      : (await db.insert(equipment).values(values).returning())[0];

    if(!oilChangeEnabled&&existing)applicableNames=(await db.select({name:maintenanceTypes.name}).from(equipmentMaintenanceTypes).innerJoin(maintenanceTypes,eq(equipmentMaintenanceTypes.maintenanceTypeId,maintenanceTypes.id)).where(and(eq(equipmentMaintenanceTypes.equipmentId,existing.id),eq(equipmentMaintenanceTypes.applicable,true)))).map((row)=>row.name);
    await db.update(equipmentMaintenanceTypes).set({ applicable:false, updatedAt:now }).where(eq(equipmentMaintenanceTypes.equipmentId,saved.id));
    const selectedTypeIds = applicableNames.map((name)=>availableByName.get(name)!).filter(Boolean);
    for (const maintenanceTypeId of selectedTypeIds) {
      await db.insert(equipmentMaintenanceTypes).values({ equipmentId:saved.id, maintenanceTypeId, applicable:true, updatedAt:now })
        .onConflictDoUpdate({ target:[equipmentMaintenanceTypes.equipmentId,equipmentMaintenanceTypes.maintenanceTypeId], set:{ applicable:true, updatedAt:now } });
    }

    const allPlans = await db.select({ id:maintenancePlans.id, maintenanceTypeId:maintenancePlans.maintenanceTypeId }).from(maintenancePlans).where(eq(maintenancePlans.equipmentId,saved.id));
    const selectedSet = new Set(selectedTypeIds); const activePlanIds:number[] = []; const inactivePlanIds:number[] = [];
    for (const plan of allPlans) (selectedSet.has(plan.maintenanceTypeId) ? activePlanIds : inactivePlanIds).push(plan.id);
    if (activePlanIds.length) await db.update(maintenancePlans).set({ active:true, updatedAt:now }).where(inArray(maintenancePlans.id,activePlanIds));
    if (inactivePlanIds.length) {
      await db.update(maintenancePlans).set({ active:false, updatedAt:now }).where(inArray(maintenancePlans.id,inactivePlanIds));
      await db.update(alerts).set({ status:"CLOSED", closedAt:now, updatedAt:now }).where(inArray(alerts.planId,inactivePlanIds));
    }

    if(oilChangeEnabled)await recalculateMaintenanceCycles(d1,{equipmentId:saved.id,force:true});
    else if(allPlans.length)await db.update(alerts).set({status:"CLOSED",closedAt:now,updatedAt:now}).where(inArray(alerts.planId,allPlans.map((plan)=>plan.id)));

    const front=frontId?(await db.select({name:serviceFronts.name}).from(serviceFronts).where(eq(serviceFronts.id,frontId)).limit(1))[0]?.name??null:null;
    return Response.json({ equipment:normalize({ ...saved, serviceFrontId:frontId,front,oilChangeEnabled }, applicableNames) }, { status:existing ? 200 : 201 });
  } catch (error) {
    const access=equipmentAccessResponse(error);if(access)return access;
    const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const message = error instanceof Error ? `${error.message} ${detail}` : "";
    if (message.includes("UNIQUE constraint failed")) return Response.json({ error:"Prefixo ou identificação já cadastrada." }, { status:409 });
    if (message.includes("no such table") || message.includes("binding `DB` is unavailable")) return Response.json({ error:"O banco de equipamentos ainda está sendo preparado. Tente novamente em instantes." }, { status:503 });
    return Response.json({ error:`Não foi possível ${editing ? "atualizar" : "cadastrar"} o equipamento agora. Tente novamente.` }, { status:500 });
  }
}

export async function POST(request:Request) { return saveEquipment(request,false); }
export async function PUT(request:Request) { return saveEquipment(request,true); }
