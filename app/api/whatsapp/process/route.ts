import { getD1 } from "../../../../db";
import { getWhatsappCronSecret,processAutomaticWhatsappAlerts } from "../../../../lib/whatsapp";

export async function POST(request:Request){
  const configured=await getWhatsappCronSecret();const supplied=(request.headers.get("authorization")??"").replace(/^Bearer\s+/i,"");
  if(!configured||!supplied||supplied!==configured)return Response.json({error:"Agendamento não autorizado."},{status:401});
  try{return Response.json({ok:true,...await processAutomaticWhatsappAlerts(await getD1(),{repeatOnly:true})});}
  catch(error){console.error("[whatsapp.process]",error);return Response.json({error:"Não foi possível processar os lembretes vencidos."},{status:500});}
}
