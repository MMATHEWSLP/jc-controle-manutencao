import { getD1 } from "../../../../db";
import { getWhatsappWebhookEnvironment } from "../../../../lib/whatsapp";

type WebhookStatus={id?:string;status?:string;timestamp?:string;errors?:Array<{title?:string;message?:string}>};
type WebhookPayload={entry?:Array<{changes?:Array<{value?:{statuses?:WebhookStatus[]}}>}>};

function bytesToHex(bytes:Uint8Array){return Array.from(bytes,(byte)=>byte.toString(16).padStart(2,"0")).join("");}
async function validSignature(raw:string,signature:string,secret:string){
  if(!signature.startsWith("sha256="))return false;const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signed=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw));return bytesToHex(new Uint8Array(signed))===signature.slice(7).toLowerCase();
}

export async function GET(request:Request){
  const url=new URL(request.url);const runtime=await getWhatsappWebhookEnvironment();
  if(runtime.verifyToken&&url.searchParams.get("hub.mode")==="subscribe"&&url.searchParams.get("hub.verify_token")===runtime.verifyToken)return new Response(url.searchParams.get("hub.challenge")??"",{status:200});
  return new Response("Verificação inválida.",{status:403});
}

export async function POST(request:Request){
  const raw=await request.text();const runtime=await getWhatsappWebhookEnvironment();
  if(!runtime.appSecret||!await validSignature(raw,request.headers.get("x-hub-signature-256")??"",runtime.appSecret))return Response.json({error:"Assinatura do webhook inválida."},{status:401});
  try{
    const payload=JSON.parse(raw) as WebhookPayload;const statuses=payload.entry?.flatMap((entry)=>entry.changes?.flatMap((change)=>change.value?.statuses??[])??[])??[];const d1=await getD1();
    for(const item of statuses){if(!item.id)continue;const status=item.status==="delivered"||item.status==="read"?"DELIVERED":item.status==="failed"?"FAILED":item.status==="sent"?"SENT":null;if(!status)continue;const when=item.timestamp?new Date(Number(item.timestamp)*1000).toISOString():new Date().toISOString();const error=item.errors?.map((entry)=>entry.message||entry.title).filter(Boolean).join("; ")||null;await d1.prepare(`UPDATE whatsapp_deliveries SET result=?,delivered_at=?,error_reason=?,updated_at=? WHERE provider_message_id=?`).bind(status,status==="DELIVERED"?when:null,error,when,item.id).run();}
    return Response.json({ok:true});
  }catch(error){console.error("[whatsapp.webhook]",error);return Response.json({error:"Webhook inválido."},{status:400});}
}
