import { eq, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { serviceFronts, users } from "../../../../db/schema";
import { assertSameOrigin, audit, createSession, effectivePermissions, ensurePrimaryAdmin, publicUser, sessionCookie, verifyPassword } from "../../../../lib/auth";

function clean(value:unknown){return typeof value==="string"?value.trim():"";}

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  try{
    await ensurePrimaryAdmin();
    const body=await request.json() as Record<string,unknown>;
    const credential=clean(body.credential).toLowerCase();const password=clean(body.password);
    if(!credential||!password)return Response.json({error:"Informe usuário ou e-mail e senha."},{status:400});
    const db=await getDb();
    const row=(await db.select().from(users).where(or(eq(users.username,credential),eq(users.email,credential))).limit(1))[0];
    if(!row||!row.username||!row.passwordHash||!row.passwordSalt||!(await verifyPassword(password,row.passwordSalt,row.passwordHash)))return Response.json({error:"Usuário ou senha incorretos."},{status:401});
    if(row.status!=="ACTIVE")return Response.json({error:"Este usuário está inativo. Procure o administrador."},{status:403});
    const now=new Date().toISOString();
    await db.update(users).set({lastAccessAt:now,updatedAt:now}).where(eq(users.id,row.id));
    const token=await createSession(row.id);
    try{await audit(row.id,row.id,"LOGIN",undefined,{at:now});}catch{ /* A auditoria não deve impedir um login válido. */ }
    const front=row.serviceFrontId?(await db.select({name:serviceFronts.name}).from(serviceFronts).where(eq(serviceFronts.id,row.serviceFrontId)).limit(1))[0]:null;
    const user={id:row.id,name:row.name,username:row.username,email:row.email,profile:row.role,hierarchyLevel:row.hierarchyLevel,status:row.status,theme:row.theme,isPrimaryAdmin:row.isPrimaryAdmin,lastAccessAt:now,createdAt:row.createdAt,permissions:await effectivePermissions(row.id,row.role),serviceFrontId:row.serviceFrontId,serviceFrontName:front?.name??null};
    return Response.json({user:publicUser(user)},{headers:{"Set-Cookie":sessionCookie(token)}});
  }catch(error){
    console.error("[auth.login] Falha interna ao autenticar",error);
    return Response.json({error:"Não foi possível conectar ao servidor. Tente novamente."},{status:503});
  }
}
