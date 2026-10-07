import { eq, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { serviceFronts, users } from "../../../../db/schema";
import { assertPasswordLoginAllowed, FieldAuthError, recordLoginAttempt } from "../../../../lib/field-auth";
import { assertSameOrigin, audit, createSession, effectivePermissions, ensurePrimaryAdmin, publicUser, sessionCookie, userServiceFrontIds, verifyPassword } from "../../../../lib/auth";

function clean(value:unknown){return typeof value==="string"?value.trim():"";}

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  try{
    await ensurePrimaryAdmin();
    const body=await request.json() as Record<string,unknown>;
    const credential=clean(body.credential).toLowerCase();const password=clean(body.password);
    // "Manter conectado": 30 dias renovando a cada uso; sem marcar, cai depois de 12 h sem uso.
    const remember=body.remember===true;
    if(!credential||!password)return Response.json({error:"Informe usuário ou e-mail e senha."},{status:400});
    const db=await getDb();
    const row=(await db.select().from(users).where(or(eq(users.username,credential),eq(users.email,credential))).limit(1))[0];
    // Bloqueio por tentativas erradas (por usuário e por aparelho), igual ao acesso de campo.
    try{await assertPasswordLoginAllowed(request,row?.id??null);}
    catch(error){if(error instanceof FieldAuthError)return Response.json({error:error.message},{status:error.status});throw error;}
    const valid=Boolean(row&&row.username&&row.passwordHash&&row.passwordSalt&&await verifyPassword(password,row.passwordSalt,row.passwordHash));
    // Funcionário de campo não tem senha (entra pelo acesso de campo) e usuário inativo não entra;
    // a mensagem é a mesma de senha errada para não confirmar a senha de uma conta desativada.
    if(!valid||!row||!row.username||row.role==="CAMPO"||row.status!=="ACTIVE"){await recordLoginAttempt(request,row?.id??null,false);return Response.json({error:"Usuário ou senha incorretos. Se a senha estiver certa, confirme com o administrador se o acesso está ativo."},{status:401});}
    await recordLoginAttempt(request,row.id,true);
    const now=new Date().toISOString();
    await db.update(users).set({lastAccessAt:now,updatedAt:now}).where(eq(users.id,row.id));
    const token=await createSession(row.id,remember?"REMEMBER":"SHORT");
    try{await audit(row.id,row.id,"LOGIN",undefined,{at:now,manterConectado:remember});}catch{ /* A auditoria não deve impedir um login válido. */ }
    const front=row.serviceFrontId?(await db.select({name:serviceFronts.name}).from(serviceFronts).where(eq(serviceFronts.id,row.serviceFrontId)).limit(1))[0]:null;
    const serviceFrontIds=row.allServiceFronts||row.role==="ADMIN"?[]:await userServiceFrontIds(row.id);
    const user={id:row.id,name:row.name,username:row.username,email:row.email,profile:row.role,taskRoleId:row.taskRoleId,status:row.status,theme:row.theme,isPrimaryAdmin:row.isPrimaryAdmin,lastAccessAt:now,createdAt:row.createdAt,permissions:await effectivePermissions(row.id,row.role),serviceFrontId:row.serviceFrontId,serviceFrontName:front?.name??null,allServiceFronts:row.allServiceFronts,serviceFrontIds,canExport:row.canExport,jobTitle:row.jobTitle};
    return Response.json({user:publicUser(user)},{headers:{"Set-Cookie":sessionCookie(token)}});
  }catch(error){
    console.error("[auth.login] Falha interna ao autenticar",error);
    return Response.json({error:"Não foi possível conectar ao servidor. Tente novamente."},{status:503});
  }
}
