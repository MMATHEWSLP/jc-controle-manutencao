import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, authBootstrap, serviceFronts, userPermissions, userSessions, users } from "../db/schema";
import type { HierarchyLevel } from "./task-authorization";

export const SESSION_COOKIE = "maintenance_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
// Cloudflare Workers Web Crypto accepts PBKDF2 iteration counts up to 100,000.
// Keep the maximum supported cost so hashing works identically in production.
const PASSWORD_ITERATIONS = 100_000;
const INITIAL_ADMIN_USERNAME = "mathews";
const INITIAL_ADMIN_EMAIL = "mathews@manutencao.local";
const INITIAL_ADMIN_BOOTSTRAP_KEY = "PRIMARY_ADMIN_MATHEWS_V3";

export const PERMISSION_GROUPS = [
  { label:"Dashboard", items:[
    ["dashboard.view","Visualizar Dashboard"],
  ]},
  { label:"Equipamentos", items:[
    ["equipment.view","Visualizar equipamentos"],
    ["equipment.create","Cadastrar equipamento"],
    ["equipment.edit","Editar equipamento"],
    ["equipment.transfer","Pode transferir equipamentos entre frentes"],
    ["equipment.applicable_types","Alterar tipos de troca aplicáveis"],
    ["equipment.edit_plan","Alterar plano de manutenção"],
  ]},
  { label:"Horímetros / KM", items:[
    ["meter.view","Visualizar leituras"],
    ["meter.create","Registrar nova leitura"],
    ["meter.edit","Editar ou excluir leitura"],
  ]},
  { label:"Trocas / Manutenção", items:[
    ["maintenance.view","Visualizar trocas"],
    ["maintenance.create","Registrar troca de óleo"],
    ["maintenance.edit","Editar ou excluir manutenção"],
    ["maintenance.history","Visualizar histórico"],
  ]},
  { label:"Alertas", items:[
    ["alerts.view","Visualizar Central de Alertas"],
    ["alerts.share","Compartilhar alertas"],
    ["alerts.settings","Alterar configurações de alerta"],
  ]},
  { label:"WhatsApp", items:[
    ["whatsapp.view","Visualizar configurações e histórico"],
    ["whatsapp.send","Enviar alertas pelo WhatsApp"],
    ["whatsapp.manage","Gerenciar destinatários e automação"],
  ]},
  { label:"Status da Frota", items:[
    ["fleet.view","Visualizar Status da Frota"],
    ["fleet.update","Atualizar status, ocorrências e pedidos"],
    ["fleet.report","Exportar relatório diário da frota"],
  ]},
  { label:"Solicitação de Materiais", items:[
    ["materials.view","Visualizar solicitações de materiais"],
    ["materials.request","Criar solicitação de materiais"],
    ["materials.ship","Separar e enviar materiais solicitados"],
    ["materials.manage","Visualizar todas as solicitações (todas as frentes/solicitantes)"],
  ]},
  { label:"Tarefas", items:[
    ["tasks.view","Acessar o módulo Tarefas (a visibilidade de cada tarefa é definida pela hierarquia)"],
    ["tasks.create","Criar tarefas e subtarefas"],
    ["tasks.edit","Editar, reatribuir, concluir ou excluir tarefas (quando autorizado pela hierarquia)"],
  ]},
  { label:"Usuários", items:[
    ["users.view","Visualizar usuários"],
    ["users.create","Criar usuários"],
    ["users.edit","Editar usuários"],
    ["users.permissions","Alterar permissões"],
    ["users.status","Ativar/desativar usuários"],
  ]},
] as const;

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((group) => group.items.map(([key]) => key));
export type Permission = typeof ALL_PERMISSIONS[number];
export type Profile = "ADMIN" | "GESTOR" | "OFICINA" | "OPERADOR" | "ALMOXARIFADO";

export const PROFILE_DEFAULTS: Record<Profile, Permission[]> = {
  ADMIN:[...ALL_PERMISSIONS],
  GESTOR:["dashboard.view","equipment.view","meter.view","maintenance.view","maintenance.history","alerts.view","alerts.share","whatsapp.view","whatsapp.send","fleet.view","fleet.update","fleet.report","materials.view","materials.manage","tasks.view","tasks.create","tasks.edit"],
  OFICINA:["equipment.view","equipment.edit_plan","meter.view","meter.create","maintenance.view","maintenance.create","maintenance.edit","maintenance.history","alerts.view","fleet.view","fleet.update","fleet.report","materials.view","materials.request","tasks.view","tasks.create","tasks.edit"],
  OPERADOR:[],
  ALMOXARIFADO:["dashboard.view","equipment.view","meter.view","maintenance.view","maintenance.history","alerts.view","fleet.view","fleet.update","fleet.report","materials.view","materials.ship","tasks.view","tasks.create","tasks.edit"],
};

export type SessionUser = {
  id:number;
  name:string;
  username:string;
  email:string;
  profile:Profile;
  hierarchyLevel:HierarchyLevel;
  status:"ACTIVE"|"INACTIVE";
  theme:"LIGHT"|"DARK";
  isPrimaryAdmin:boolean;
  lastAccessAt:string|null;
  createdAt:string;
  permissions:Permission[];
  serviceFrontId:number|null;
  serviceFrontName:string|null;
};

function bytesToBase64Url(bytes:Uint8Array) {
  let binary="";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}

function bytesToHex(bytes:Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2,"0")).join("");
}

function hexToBytes(value:string) {
  const bytes=new Uint8Array(value.length/2);
  for(let index=0;index<bytes.length;index++) bytes[index]=Number.parseInt(value.slice(index*2,index*2+2),16);
  return bytes;
}

export function newSalt() {
  const bytes=new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function passwordHash(password:string,salt:string) {
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:new TextEncoder().encode(salt),iterations:PASSWORD_ITERATIONS},material,256);
  return bytesToHex(new Uint8Array(bits));
}

export async function verifyPassword(password:string,salt:string,expected:string) {
  const actual=hexToBytes(await passwordHash(password,salt));
  const target=hexToBytes(expected);
  if(actual.length!==target.length)return false;
  let difference=0;
  for(let index=0;index<actual.length;index++) difference|=actual[index]^target[index];
  return difference===0;
}

async function tokenHash(token:string) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

function readCookie(request:Request,name:string) {
  const cookie=request.headers.get("cookie")??"";
  for(const part of cookie.split(";")){
    const [key,...value]=part.trim().split("=");
    if(key===name)return decodeURIComponent(value.join("="));
  }
  return "";
}

export function assertSameOrigin(request:Request) {
  const origin=request.headers.get("origin");
  if(!origin)return true;
  let originHost:string;
  try{ originHost=new URL(origin).host; }catch{ return false; }
  // Atrás de um proxy reverso (Hostinger, Nginx, etc.) o servidor Node enxerga a si
  // mesmo como "localhost:porta", então comparar com a URL interna do request faria
  // todo login legítimo ser recusado. O endereço real do site chega nos cabeçalhos
  // encaminhados pelo proxy, e é com eles que a origem precisa ser comparada.
  const candidatos=[
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
    new URL(request.url).host,
  ];
  return candidatos.some((candidato)=>
    Boolean(candidato)&&candidato!.split(",").some((parte)=>parte.trim()===originHost)
  );
}

export function sessionCookie(token:string) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function createSession(userId:number) {
  const tokenBytes=new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token=bytesToBase64Url(tokenBytes);
  const now=new Date();
  const expires=new Date(now.getTime()+SESSION_SECONDS*1000).toISOString();
  const db=await getDb();
  await db.insert(userSessions).values({id:crypto.randomUUID(),userId,tokenHash:await tokenHash(token),expiresAt:expires,lastSeenAt:now.toISOString()});
  return token;
}

export async function destroySession(request:Request) {
  const token=readCookie(request,SESSION_COOKIE);
  if(!token)return;
  const db=await getDb();
  await db.delete(userSessions).where(eq(userSessions.tokenHash,await tokenHash(token)));
}

export async function effectivePermissions(userId:number,profile:Profile) {
  if(profile==="ADMIN")return [...ALL_PERMISSIONS];
  const db=await getDb();
  const overrides=await db.select({permission:userPermissions.permission,enabled:userPermissions.enabled}).from(userPermissions).where(eq(userPermissions.userId,userId));
  const values=new Set<Permission>(PROFILE_DEFAULTS[profile]??[]);
  for(const row of overrides){
    if(!ALL_PERMISSIONS.includes(row.permission as Permission))continue;
    if(row.enabled)values.add(row.permission as Permission);else values.delete(row.permission as Permission);
  }
  return [...values];
}

export async function getSessionUser(request:Request):Promise<SessionUser|null> {
  const token=readCookie(request,SESSION_COOKIE);
  if(!token)return null;
  const db=await getDb();
  const rows=await db.select({
    id:users.id,name:users.name,username:users.username,email:users.email,profile:users.role,hierarchyLevel:users.hierarchyLevel,status:users.status,
    theme:users.theme,isPrimaryAdmin:users.isPrimaryAdmin,lastAccessAt:users.lastAccessAt,createdAt:users.createdAt,
    serviceFrontId:users.serviceFrontId,serviceFrontName:serviceFronts.name,
  }).from(userSessions).innerJoin(users,eq(userSessions.userId,users.id)).leftJoin(serviceFronts,eq(users.serviceFrontId,serviceFronts.id)).where(and(eq(userSessions.tokenHash,await tokenHash(token)),gt(userSessions.expiresAt,new Date().toISOString()))).limit(1);
  const row=rows[0];
  if(!row||row.status!=="ACTIVE"||!row.username)return null;
  return {...row,username:row.username,hierarchyLevel:row.hierarchyLevel as HierarchyLevel,permissions:await effectivePermissions(row.id,row.profile)};
}

export async function authorize(request:Request,permission?:Permission) {
  const user=await getSessionUser(request);
  if(!user)return {user:null,response:Response.json({error:"Sessão não autenticada."},{status:401})};
  if(permission&&!user.permissions.includes(permission))return {user:null,response:Response.json({error:"Você não possui permissão para esta ação."},{status:403})};
  return {user,response:null};
}

export async function audit(actorId:number|null,affectedUserId:number,action:string,previousValue?:unknown,newValue?:unknown) {
  const db=await getDb();
  await db.insert(auditLogs).values({
    userId:actorId,entityType:"USER",entityId:String(affectedUserId),action,
    previousValue:previousValue===undefined?null:JSON.stringify(previousValue),
    newValue:newValue===undefined?null:JSON.stringify(newValue),
  });
}

export async function ensurePrimaryAdmin() {
  const db=await getDb();
  const completed=(await db.select({key:authBootstrap.key}).from(authBootstrap).where(eq(authBootstrap.key,INITIAL_ADMIN_BOOTSTRAP_KEY)).limit(1))[0];
  if(completed)return;
  const initialPassword=typeof process.env.INITIAL_ADMIN_PASSWORD==="string"?process.env.INITIAL_ADMIN_PASSWORD:"";
  if(!initialPassword)throw new Error("A credencial inicial do administrador não está configurada no servidor.");

  const salt=newSalt();
  const now=new Date().toISOString();
  const hash=await passwordHash(initialPassword,salt);
  let existing=(await db.select({id:users.id}).from(users).where(eq(users.username,INITIAL_ADMIN_USERNAME)).limit(1))[0];
  if(!existing)existing=(await db.select({id:users.id}).from(users).where(eq(users.email,INITIAL_ADMIN_EMAIL)).limit(1))[0];

  let adminId:number;
  if(existing){
    adminId=existing.id;
    await db.update(users).set({
      name:"Mathews",username:INITIAL_ADMIN_USERNAME,passwordHash:hash,passwordSalt:salt,
      role:"ADMIN",hierarchyLevel:"ADMIN",status:"ACTIVE",isPrimaryAdmin:true,passwordUpdatedAt:now,updatedAt:now,
    }).where(eq(users.id,adminId));
    await db.delete(userSessions).where(eq(userSessions.userId,adminId));
  }else{
    const inserted=await db.insert(users).values({
      email:INITIAL_ADMIN_EMAIL,name:"Mathews",username:INITIAL_ADMIN_USERNAME,
      passwordHash:hash,passwordSalt:salt,role:"ADMIN",hierarchyLevel:"ADMIN",status:"ACTIVE",
      theme:"LIGHT",isPrimaryAdmin:true,passwordUpdatedAt:now,updatedAt:now,
    }).returning({id:users.id});
    adminId=inserted[0].id;
  }

  await db.insert(authBootstrap).values({key:INITIAL_ADMIN_BOOTSTRAP_KEY,completedAt:now}).onConflictDoNothing();
  console.info("[auth.bootstrap] Administrador principal verificado",{userId:adminId});
}

export function publicUser(user:SessionUser) {
  return user;
}

export function profileLabel(profile:Profile) {
  return profile==="ADMIN"?"Administrador":profile==="GESTOR"?"Gestor":profile==="OFICINA"?"Manutenção / Oficina":profile==="OPERADOR"?"Operador":"Operador";
}
