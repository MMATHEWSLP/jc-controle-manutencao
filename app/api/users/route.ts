import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { serviceFronts, userPermissions, userSessions, users } from "../../../db/schema";
import { ALL_PERMISSIONS, PROFILE_DEFAULTS, type Permission, type Profile, assertSameOrigin, audit, authorize, effectivePermissions, newSalt, passwordHash, profileLabel } from "../../../lib/auth";

const editableProfiles:Profile[]=["ADMIN","GESTOR","OFICINA","OPERADOR"];
function clean(value:unknown){return typeof value==="string"?value.trim():"";}
function validEmail(value:string){return /^\S+@\S+\.\S+$/.test(value);}
function validUsername(value:string){return /^[a-z0-9._-]{3,40}$/.test(value);}
function passwordError(password:string){
  if(password.length<10)return "A senha deve ter pelo menos 10 caracteres.";
  if(!/[A-Z]/.test(password)||!/[a-z]/.test(password)||!/[0-9]/.test(password)||!/[\W_]/.test(password))return "Use letra maiúscula, minúscula, número e símbolo na senha.";
  return "";
}
function validPermissions(value:unknown):Permission[]{
  if(!Array.isArray(value))return [];
  return [...new Set(value.filter((permission):permission is Permission=>typeof permission==="string"&&ALL_PERMISSIONS.includes(permission as Permission)))];
}

async function replaceOverrides(userId:number,profile:Profile,permissions:Permission[]){
  const db=await getDb();const desired=new Set(permissions);const defaults=new Set(PROFILE_DEFAULTS[profile]??[]);const now=new Date().toISOString();
  await db.delete(userPermissions).where(eq(userPermissions.userId,userId));
  for(const permission of ALL_PERMISSIONS){
    if(desired.has(permission)===defaults.has(permission))continue;
    await db.insert(userPermissions).values({userId,permission,enabled:desired.has(permission),updatedAt:now});
  }
}

async function serialize(row:typeof users.$inferSelect){
  const profile=(row.role==="ALMOXARIFADO"?"OPERADOR":row.role) as Profile;
  const db=await getDb();const front=row.serviceFrontId?(await db.select({name:serviceFronts.name}).from(serviceFronts).where(eq(serviceFronts.id,row.serviceFrontId)).limit(1))[0]:null;
  return {id:row.id,name:row.name,username:row.username??"",email:row.email,profile,profileLabel:profileLabel(profile),status:row.status,lastAccessAt:row.lastAccessAt,createdAt:row.createdAt,isPrimaryAdmin:row.isPrimaryAdmin,permissions:await effectivePermissions(row.id,row.role),serviceFrontId:row.serviceFrontId,serviceFrontName:front?.name??null};
}

async function serviceFrontId(value:unknown,required:boolean){
  const id=Number(value);if(!Number.isInteger(id)||id<=0){if(required)throw new Error("SERVICE_FRONT_REQUIRED");return null;}
  const db=await getDb();const front=(await db.select({id:serviceFronts.id}).from(serviceFronts).where(eq(serviceFronts.id,id)).limit(1))[0];
  if(!front)throw new Error("SERVICE_FRONT_INVALID");return front.id;
}

export async function GET(request:Request){
  const auth=await authorize(request,"users.view");if(auth.response)return auth.response;
  try{
    const db=await getDb();const rows=await db.select().from(users).orderBy(asc(users.name));
    return Response.json({users:await Promise.all(rows.map(serialize))});
  }catch{return Response.json({error:"Não foi possível carregar os usuários agora."},{status:500});}
}

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"users.create");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;
    const name=clean(body.name);const username=clean(body.username).toLowerCase();const email=clean(body.email).toLowerCase();const password=clean(body.password);
    let profile=clean(body.profile) as Profile;const status=clean(body.status)==="INACTIVE"?"INACTIVE":"ACTIVE";
    if(!name||!username||!email||!password)return Response.json({error:"Preencha nome, usuário, e-mail e senha."},{status:400});
    if(!validUsername(username))return Response.json({error:"O usuário deve ter de 3 a 40 caracteres e usar apenas letras, números, ponto, hífen ou sublinhado."},{status:400});
    if(!validEmail(email))return Response.json({error:"Informe um e-mail válido."},{status:400});
    const invalidPassword=passwordError(password);if(invalidPassword)return Response.json({error:invalidPassword},{status:400});
    if(!editableProfiles.includes(profile))profile="OPERADOR";
    const canAssign=auth.user!.permissions.includes("users.permissions");if(!canAssign)profile="OPERADOR";
    const frontId=await serviceFrontId(body.serviceFrontId,profile!=="ADMIN");
    const salt=newSalt();const now=new Date().toISOString();const db=await getDb();
    const saved=(await db.insert(users).values({name,username,email,passwordSalt:salt,passwordHash:await passwordHash(password,salt),role:profile,status,theme:"LIGHT",isPrimaryAdmin:false,passwordUpdatedAt:now,serviceFrontId:frontId,updatedAt:now}).returning())[0];
    const permissions=canAssign?validPermissions(body.permissions):PROFILE_DEFAULTS.OPERADOR;
    await replaceOverrides(saved.id,profile,permissions);
    await audit(auth.user!.id,saved.id,"USER_CREATED",undefined,{name,username,email,profile,status,serviceFrontId:frontId});
    if(canAssign)await audit(auth.user!.id,saved.id,"PERMISSIONS_CHANGED",undefined,{permissions});
    return Response.json({user:await serialize(saved)},{status:201});
  }catch(error){
    const message=error instanceof Error?error.message:"";
    if(message.includes("SERVICE_FRONT_REQUIRED"))return Response.json({error:"Selecione a frente de serviço do usuário."},{status:400});
    if(message.includes("SERVICE_FRONT_INVALID"))return Response.json({error:"A frente de serviço selecionada não existe."},{status:400});
    if(message.includes("UNIQUE constraint"))return Response.json({error:"Usuário ou e-mail já cadastrado."},{status:409});
    return Response.json({error:"Não foi possível criar o usuário agora."},{status:500});
  }
}

export async function PUT(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"users.edit");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const id=Number(body.id);const action=clean(body.action)||"UPDATE";
    if(!Number.isInteger(id)||id<=0)return Response.json({error:"Usuário inválido."},{status:400});
    const db=await getDb();const current=(await db.select().from(users).where(eq(users.id,id)).limit(1))[0];
    if(!current)return Response.json({error:"Usuário não encontrado."},{status:404});
    if(current.isPrimaryAdmin&&auth.user!.id!==id)return Response.json({error:"Somente o próprio administrador principal pode alterar seus dados ou sua senha."},{status:403});
    if(action==="RESET_PASSWORD"){
      const password=clean(body.password);const invalidPassword=passwordError(password);if(invalidPassword)return Response.json({error:invalidPassword},{status:400});
      const salt=newSalt();const now=new Date().toISOString();
      await db.update(users).set({passwordSalt:salt,passwordHash:await passwordHash(password,salt),passwordUpdatedAt:now,updatedAt:now}).where(eq(users.id,id));
      await db.delete(userSessions).where(eq(userSessions.userId,id));
      await audit(auth.user!.id,id,"PASSWORD_RESET",undefined,{at:now});
      return Response.json({ok:true});
    }

    const name=clean(body.name);const username=clean(body.username).toLowerCase();const email=clean(body.email).toLowerCase();
    if(!name||!validUsername(username)||!validEmail(email))return Response.json({error:"Revise nome, usuário e e-mail."},{status:400});
    const requestedProfile=editableProfiles.includes(clean(body.profile) as Profile)?clean(body.profile) as Profile:"OPERADOR";
    const requestedStatus=clean(body.status)==="INACTIVE"?"INACTIVE":"ACTIVE";
    const canPermissions=auth.user!.permissions.includes("users.permissions");const canStatus=auth.user!.permissions.includes("users.status");
    const editingSelf=auth.user!.id===id;
    const nextProfile=current.isPrimaryAdmin?"ADMIN":editingSelf||!canPermissions?current.role:requestedProfile;
    const nextStatus=current.isPrimaryAdmin||editingSelf||!canStatus?current.status:requestedStatus;
    const canChangeFront=!current.isPrimaryAdmin&&!editingSelf&&canPermissions;
    const nextFrontId=canChangeFront?await serviceFrontId(body.serviceFrontId,nextProfile!=="ADMIN"):current.serviceFrontId;
    const before={name:current.name,username:current.username,email:current.email,profile:current.role,status:current.status,serviceFrontId:current.serviceFrontId};
    const now=new Date().toISOString();
    const saved=(await db.update(users).set({name,username,email,role:nextProfile,status:nextStatus,serviceFrontId:nextFrontId,updatedAt:now}).where(eq(users.id,id)).returning())[0];
    await audit(auth.user!.id,id,"USER_EDITED",before,{name,username,email,profile:nextProfile,status:nextStatus,serviceFrontId:nextFrontId});
    if(nextStatus!==current.status){await db.delete(userSessions).where(eq(userSessions.userId,id));await audit(auth.user!.id,id,nextStatus==="ACTIVE"?"USER_ACTIVATED":"USER_DEACTIVATED",{status:current.status},{status:nextStatus});}
    if(canPermissions&&!editingSelf&&!current.isPrimaryAdmin&&Array.isArray(body.permissions)){
      const previous=await effectivePermissions(id,current.role);const permissions=validPermissions(body.permissions);await replaceOverrides(id,nextProfile as Profile,permissions);await audit(auth.user!.id,id,"PERMISSIONS_CHANGED",{permissions:previous},{permissions});
    }
    return Response.json({user:await serialize(saved)});
  }catch(error){
    const message=error instanceof Error?error.message:"";
    if(message.includes("SERVICE_FRONT_REQUIRED"))return Response.json({error:"Selecione a frente de serviço do usuário."},{status:400});
    if(message.includes("SERVICE_FRONT_INVALID"))return Response.json({error:"A frente de serviço selecionada não existe."},{status:400});
    if(message.includes("UNIQUE constraint"))return Response.json({error:"Usuário ou e-mail já cadastrado."},{status:409});
    return Response.json({error:"Não foi possível atualizar o usuário agora."},{status:500});
  }
}
