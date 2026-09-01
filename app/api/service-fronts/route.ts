import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { activeServiceFronts } from "../../../lib/front-scope";

export async function GET(request:Request){
  const auth=await authorize(request);if(auth.response)return auth.response;
  try{return Response.json({fronts:await activeServiceFronts(await getD1())});}
  catch(error){console.error("[service-fronts.get]",error);return Response.json({error:"Não foi possível carregar as frentes de serviço."},{status:500});}
}
