import { ensurePrimaryAdmin, getSessionUser, publicUser } from "../../../../lib/auth";

export async function GET(request:Request) {
  try {
    await ensurePrimaryAdmin();
    const user=await getSessionUser(request);
    return Response.json({user:user?publicUser(user):null});
  } catch (error) {
    console.error("[auth.session] Falha interna ao validar sessão",error);
    return Response.json({error:"Não foi possível validar a sessão agora."},{status:503});
  }
}
