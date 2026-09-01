import type { D1DatabaseLike } from "../db";
import type { SessionUser } from "./auth";

type Row=Record<string,unknown>;
export type EquipmentScopeMode="OPERATIONAL"|"OIL"|"MANAGEMENT";

const INITIAL_SERVICE_FRONTS=["Mamuru","Flexal","Arapiuns"] as const;

export class EquipmentAccessError extends Error {
  constructor(message:string,public status:403|404){super(message);}
}

export function isAdministrator(user:SessionUser){return user.profile==="ADMIN";}
export function canBrowseAllEquipment(user:SessionUser,mode:EquipmentScopeMode){
  return isAdministrator(user)||(mode==="MANAGEMENT"&&user.permissions.includes("equipment.transfer"));
}

export function equipmentScopeSql(user:SessionUser,mode:EquipmentScopeMode,alias="e"){
  const clauses:string[]=[];const values:unknown[]=[];
  if(mode==="OIL")clauses.push(`${alias}.oil_change_enabled=1`);
  if(!canBrowseAllEquipment(user,mode)){
    if(!user.serviceFrontId)clauses.push("1=0");
    else {clauses.push(`${alias}.service_front_id=?`);values.push(user.serviceFrontId);}
  }
  return {clause:clauses.length?clauses.join(" AND "):"1=1",values};
}

export async function ensureInitialServiceFronts(d1:D1DatabaseLike){
  const now=new Date().toISOString();
  await d1.batch(INITIAL_SERVICE_FRONTS.map((name)=>d1.prepare(`INSERT INTO service_fronts (name,active,created_at,updated_at) VALUES (?,TRUE,?,?) ON CONFLICT(name) DO UPDATE SET active=TRUE,updated_at=excluded.updated_at`).bind(name,now,now)));
}

export async function activeServiceFronts(d1:D1DatabaseLike){
  await ensureInitialServiceFronts(d1);
  const result=await d1.prepare(`SELECT id,name,location,active FROM service_fronts WHERE active=1 ORDER BY name`).all<Row>();
  return result.results.map((row)=>({id:Number(row.id),name:String(row.name),location:row.location==null?null:String(row.location),active:Number(row.active)===1}));
}

export async function allowedEquipmentIds(d1:D1DatabaseLike,user:SessionUser,mode:EquipmentScopeMode){
  const scope=equipmentScopeSql(user,mode,"e");
  const result=await d1.prepare(`SELECT e.id FROM equipment e WHERE ${scope.clause}`).bind(...scope.values).all<Row>();
  return new Set(result.results.map((row)=>Number(row.id)));
}

export async function requireEquipmentAccess(d1:D1DatabaseLike,user:SessionUser,equipmentId:number,mode:EquipmentScopeMode){
  const equipment=await d1.prepare(`SELECT id,prefix,service_front_id,oil_change_enabled FROM equipment WHERE id=?`).bind(equipmentId).first<Row>();
  if(!equipment)throw new EquipmentAccessError("Equipamento não encontrado.",404);
  if(mode==="OIL"&&Number(equipment.oil_change_enabled)!==1)throw new EquipmentAccessError("Este equipamento não participa do módulo Troca de Óleo.",403);
  if(!canBrowseAllEquipment(user,mode)&&(!user.serviceFrontId||Number(equipment.service_front_id)!==user.serviceFrontId)){
    throw new EquipmentAccessError("Você não possui acesso a este equipamento.",403);
  }
  return {id:Number(equipment.id),prefix:String(equipment.prefix),serviceFrontId:equipment.service_front_id==null?null:Number(equipment.service_front_id),oilChangeEnabled:Number(equipment.oil_change_enabled)===1};
}

export function equipmentAccessResponse(error:unknown){
  return error instanceof EquipmentAccessError?Response.json({error:error.message},{status:error.status}):null;
}
