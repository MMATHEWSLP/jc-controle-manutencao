import type { D1DatabaseLike } from "../db";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";

type Row=Record<string,unknown>;
export type EquipmentScopeMode="OPERATIONAL"|"OIL"|"MANAGEMENT";

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
    const fronts=frentesVisiveis(user);
    if(fronts!=="ALL"){
      if(fronts.length===0)clauses.push("1=0");
      else {clauses.push(`${alias}.service_front_id=ANY(?)`);values.push(fronts);}
    }
  }
  return {clause:clauses.length?clauses.join(" AND "):"1=1",values};
}

export async function activeServiceFronts(d1:D1DatabaseLike){
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
  if(!canBrowseAllEquipment(user,mode)){
    const fronts=frentesVisiveis(user);
    const equipmentFrontId=equipment.service_front_id==null?null:Number(equipment.service_front_id);
    const allowed=fronts==="ALL"||(equipmentFrontId!==null&&fronts.includes(equipmentFrontId));
    if(!allowed)throw new EquipmentAccessError("Você não possui acesso a este equipamento.",403);
  }
  return {id:Number(equipment.id),prefix:String(equipment.prefix),serviceFrontId:equipment.service_front_id==null?null:Number(equipment.service_front_id),oilChangeEnabled:Number(equipment.oil_change_enabled)===1};
}

export function equipmentAccessResponse(error:unknown){
  return error instanceof EquipmentAccessError?Response.json({error:error.message},{status:error.status}):null;
}
