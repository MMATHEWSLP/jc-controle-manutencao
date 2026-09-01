import { assertSameOrigin, audit, authorize, clearSessionCookie, destroySession } from "../../../../lib/auth";

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const {user}=await authorize(request);
  if(user)await audit(user.id,user.id,"LOGOUT");
  await destroySession(request);
  return Response.json({ok:true},{headers:{"Set-Cookie":clearSessionCookie()}});
}
