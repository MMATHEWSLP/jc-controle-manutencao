import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { users } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";

export async function PUT(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request);if(auth.response)return auth.response;
  const body=await request.json() as {theme?:string};
  if(body.theme!=="LIGHT"&&body.theme!=="DARK")return Response.json({error:"Tema inválido."},{status:400});
  const db=await getDb();await db.update(users).set({theme:body.theme,updatedAt:new Date().toISOString()}).where(eq(users.id,auth.user!.id));
  return Response.json({theme:body.theme});
}
