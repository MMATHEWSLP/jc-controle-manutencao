import { getD1 } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import {
  getWhatsappConfiguration,getWhatsappSettings,listWhatsappDeliveries,listWhatsappRecipients,normalizeWhatsappPhone,prepareManualWhatsappAlerts,
  saveWhatsappConnection,sendManualWhatsappAlerts,sendWhatsappTest,testWhatsappConnection,type WhatsappLevel,validBrazilWhatsappPhone,
} from "../../../lib/whatsapp";
import { allowedEquipmentIds,isAdministrator } from "../../../lib/front-scope";

type Row=Record<string,unknown>;
const categories=["PC","SK","TE","CM","CA","MN"];
const levels:WhatsappLevel[]=["WARNING","NEAR","OVERDUE"];
const clean=(value:unknown)=>typeof value==="string"?value.trim():"";
const list=(value:unknown,allowed:string[],fallback:string[])=>Array.isArray(value)?[...new Set(value.map(String).filter((item)=>allowed.includes(item)))]:fallback;

function recipientPayload(body:Record<string,unknown>){
  const name=clean(body.name);const phone=normalizeWhatsappPhone(body.phone);const active=body.active!==false;
  const selectedCategories=list(body.categories,["ALL",...categories],["ALL"]);const alertTypes=list(body.alertTypes,levels,levels) as WhatsappLevel[];
  if(!name)return {error:"Informe o nome do destinatário."};
  if(!validBrazilWhatsappPhone(phone))return {error:"Informe o número no formato 55 + DDD + número, somente dígitos."};
  if(selectedCategories.length===0||alertTypes.length===0)return {error:"Selecione pelo menos uma categoria e um tipo de alerta."};
  return {name,phone,active,categories:selectedCategories.includes("ALL")?["ALL"]:selectedCategories,alertTypes};
}

async function audit(d1:Awaited<ReturnType<typeof getD1>>,userId:number,entityType:string,entityId:string,action:string,previousValue:unknown,newValue:unknown){
  await d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(userId,entityType,entityId,action,previousValue===undefined?null:JSON.stringify(previousValue),newValue===undefined?null:JSON.stringify(newValue),new Date().toISOString()).run();
}

export async function GET(request:Request){
  const auth=await authorize(request,"whatsapp.view");if(auth.response)return auth.response;
  try{const d1=await getD1();const [configuration,recipients,allDeliveries,allowed]=await Promise.all([getWhatsappConfiguration(d1),listWhatsappRecipients(d1),listWhatsappDeliveries(d1),allowedEquipmentIds(d1,auth.user!,"OIL")]);const deliveries=allDeliveries.filter((item)=>item.equipmentId!==null?allowed.has(item.equipmentId):isAdministrator(auth.user!));return Response.json({configuration,recipients,deliveries,categories,alertTypes:levels});}
  catch(error){console.error("[whatsapp.get]",error);return Response.json({error:"Não foi possível carregar as configurações do WhatsApp."},{status:500});}
}

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  try{
    const body=await request.json() as Record<string,unknown>;const action=clean(body.action);const d1=await getD1();
    if(action==="CREATE_RECIPIENT"){
      const auth=await authorize(request,"whatsapp.manage");if(auth.response)return auth.response;const payload=recipientPayload(body);if("error" in payload)return Response.json({error:payload.error},{status:400});const now=new Date().toISOString();
      await d1.prepare(`INSERT INTO whatsapp_recipients (name,phone,active,categories,alert_types,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(payload.name,payload.phone,payload.active?1:0,JSON.stringify(payload.categories),JSON.stringify(payload.alertTypes),auth.user!.id,now,now).run();
      const saved=await d1.prepare(`SELECT id FROM whatsapp_recipients WHERE phone=?`).bind(payload.phone).first<Row>();await audit(d1,auth.user!.id,"WHATSAPP_RECIPIENT",String(saved?.id??payload.phone),"DESTINATÁRIO CRIADO",undefined,payload);
      return Response.json({ok:true,message:"Destinatário cadastrado com sucesso."},{status:201});
    }
    if(action==="START_SEND"||action==="SEND_MANUAL"){
      const auth=await authorize(request,"whatsapp.send");if(auth.response)return auth.response;const planIds=Array.isArray(body.planIds)?[...new Set(body.planIds.map(Number).filter((id)=>Number.isInteger(id)&&id>0))]:[];if(!planIds.length)return Response.json({error:"Selecione pelo menos um alerta."},{status:400});
      const allowed=await allowedEquipmentIds(d1,auth.user!,"OIL");const linked=await d1.prepare(`SELECT p.id,e.id AS equipment_id FROM maintenance_plans p INNER JOIN equipment e ON e.id=p.equipment_id WHERE p.id IN (${planIds.map(()=>"?").join(",")})`).bind(...planIds).all<Row>();
      if(linked.results.length!==planIds.length||linked.results.some((row)=>!allowed.has(Number(row.equipment_id))))return Response.json({error:"Um dos alertas selecionados não pertence à sua frente de serviço."},{status:403});
      const settings=await getWhatsappSettings(d1);
      if(settings.sendMode==="MANUAL"){
        const prepared=await prepareManualWhatsappAlerts(d1,planIds);await audit(d1,auth.user!.id,"WHATSAPP","MANUAL","ABERTURA MANUAL PREPARADA",undefined,{planIds,alerts:prepared.alerts.length,recipients:prepared.recipients.length});
        if(prepared.alerts.length===0||prepared.recipients.length===0)return Response.json({error:"Nenhum destinatário ativo corresponde às categorias e tipos selecionados."},{status:400});
        return Response.json({mode:"MANUAL",...prepared});
      }
      const result=await sendManualWhatsappAlerts(d1,planIds,auth.user!.id);await audit(d1,auth.user!.id,"WHATSAPP","MANUAL","ENVIO MANUAL",undefined,{planIds,...result});
      if(result.processed===0)return Response.json({error:"Nenhum destinatário ativo corresponde às categorias e tipos selecionados."},{status:400});
      return Response.json({mode:"API",...result,message:`Envio concluído: ${result.sent} enviado(s) e ${result.failed} falha(s).`});
    }
    if(action==="TEST"){
      const auth=await authorize(request,"whatsapp.manage");if(auth.response)return auth.response;const recipientId=Number(body.recipientId);const recipients=await listWhatsappRecipients(d1);const recipient=recipients.find((item)=>item.id===recipientId);if(!recipient)return Response.json({error:"Destinatário não encontrado."},{status:404});
      const result=await sendWhatsappTest(d1,recipient,auth.user!.id);await audit(d1,auth.user!.id,"WHATSAPP","TEST","TESTE DE INTEGRAÇÃO",undefined,{recipientId,result:result.result});
      if(result.result==="FAILED")return Response.json({error:result.error??"A mensagem de teste falhou, mas a tentativa foi registrada."},{status:502});
      return Response.json({ok:true,message:"Mensagem de teste enviada e registrada no histórico."});
    }
    if(action==="TEST_CONNECTION"){
      const auth=await authorize(request,"whatsapp.manage");if(auth.response)return auth.response;const result=await testWhatsappConnection(d1);
      await audit(d1,auth.user!.id,"WHATSAPP_CONNECTION","1","CONEXÃO TESTADA",undefined,{ok:result.ok,error:"error" in result?result.error:undefined});
      if(!result.ok)return Response.json({error:result.error},{status:502});
      return Response.json(result);
    }
    return Response.json({error:"Ação de WhatsApp inválida."},{status:400});
  }catch(error){const message=error instanceof Error?error.message:"";console.error("[whatsapp.post]",error);if(message.includes("UNIQUE constraint"))return Response.json({error:"Este número já está cadastrado."},{status:409});if(message.includes("integração WhatsApp não configurada"))return Response.json({error:message},{status:409});return Response.json({error:"Não foi possível concluir a operação do WhatsApp."},{status:500});}
}

export async function PUT(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"whatsapp.manage");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const action=clean(body.action);const d1=await getD1();const now=new Date().toISOString();
    if(action==="UPDATE_SETTINGS"){
      const sendMode=clean(body.sendMode)==="API"?"API":"MANUAL";const automaticEnabled=sendMode==="API"&&body.automaticEnabled===true;const overdueRepeatDays=Number(body.overdueRepeatDays);const templateName=clean(body.templateName);const templateLanguage=clean(body.templateLanguage)||"pt_BR";
      if(![0,1,2,3,7].includes(overdueRepeatDays))return Response.json({error:"Selecione uma frequência de repetição válida."},{status:400});
      const previous=await d1.prepare(`SELECT send_mode,automatic_enabled,overdue_repeat_days,template_name,template_language FROM whatsapp_settings WHERE id=1`).first<Row>();
      await d1.prepare(`INSERT INTO whatsapp_settings (id,send_mode,automatic_enabled,overdue_repeat_days,template_name,template_language,created_at,updated_at) VALUES (1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET send_mode=excluded.send_mode,automatic_enabled=excluded.automatic_enabled,overdue_repeat_days=excluded.overdue_repeat_days,template_name=excluded.template_name,template_language=excluded.template_language,updated_at=excluded.updated_at`)
        .bind(sendMode,automaticEnabled?1:0,overdueRepeatDays,templateName||null,templateLanguage,now,now).run();
      await audit(d1,auth.user!.id,"WHATSAPP_SETTINGS","1","CONFIGURAÇÃO ALTERADA",previous,{sendMode,automaticEnabled,overdueRepeatDays,templateName,templateLanguage});return Response.json({ok:true,message:sendMode==="MANUAL"?"Modo manual ativado. A configuração da API foi preservada.":"Modo API ativado. Os envios usarão a integração configurada."});
    }
    if(action==="UPDATE_CONNECTION"){
      const previous=await d1.prepare(`SELECT connection_name,sender_phone,phone_number_id,waba_id,api_version,connection_status,last_tested_at FROM whatsapp_settings WHERE id=1`).first<Row>();
      const result=await saveWhatsappConnection(d1,{connectionName:body.connectionName,senderPhone:body.senderPhone,phoneNumberId:body.phoneNumberId,wabaId:body.wabaId,accessToken:body.accessToken,apiVersion:body.apiVersion});
      if("error" in result)return Response.json({error:result.error},{status:400});
      await audit(d1,auth.user!.id,"WHATSAPP_CONNECTION","1","CONEXÃO CONFIGURADA",previous,{connectionName:clean(body.connectionName),senderPhone:normalizeWhatsappPhone(body.senderPhone),phoneNumberId:clean(body.phoneNumberId),wabaId:clean(body.wabaId),apiVersion:clean(body.apiVersion),accessTokenUpdated:Boolean(clean(body.accessToken))});
      return Response.json(result);
    }
    if(action==="UPDATE_RECIPIENT"){
      const id=Number(body.id);if(!Number.isInteger(id)||id<=0)return Response.json({error:"Destinatário inválido."},{status:400});const payload=recipientPayload(body);if("error" in payload)return Response.json({error:payload.error},{status:400});const previous=await d1.prepare(`SELECT * FROM whatsapp_recipients WHERE id=?`).bind(id).first<Row>();if(!previous)return Response.json({error:"Destinatário não encontrado."},{status:404});
      await d1.prepare(`UPDATE whatsapp_recipients SET name=?,phone=?,active=?,categories=?,alert_types=?,updated_at=? WHERE id=?`).bind(payload.name,payload.phone,payload.active?1:0,JSON.stringify(payload.categories),JSON.stringify(payload.alertTypes),now,id).run();await audit(d1,auth.user!.id,"WHATSAPP_RECIPIENT",String(id),"DESTINATÁRIO EDITADO",previous,payload);return Response.json({ok:true,message:"Destinatário atualizado."});
    }
    return Response.json({error:"Ação de WhatsApp inválida."},{status:400});
  }catch(error){const message=error instanceof Error?error.message:"";console.error("[whatsapp.put]",error);if(message.includes("UNIQUE constraint"))return Response.json({error:"Este número já está cadastrado."},{status:409});return Response.json({error:"Não foi possível salvar as configurações do WhatsApp."},{status:500});}
}

export async function DELETE(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"whatsapp.manage");if(auth.response)return auth.response;
  try{const body=await request.json() as Record<string,unknown>;const id=Number(body.id);if(!Number.isInteger(id)||id<=0)return Response.json({error:"Destinatário inválido."},{status:400});const d1=await getD1();const previous=await d1.prepare(`SELECT * FROM whatsapp_recipients WHERE id=?`).bind(id).first<Row>();if(!previous)return Response.json({error:"Destinatário não encontrado."},{status:404});await d1.batch([d1.prepare(`UPDATE whatsapp_deliveries SET recipient_id=NULL WHERE recipient_id=?`).bind(id),d1.prepare(`DELETE FROM whatsapp_recipients WHERE id=?`).bind(id)]);await audit(d1,auth.user!.id,"WHATSAPP_RECIPIENT",String(id),"DESTINATÁRIO EXCLUÍDO",previous,undefined);return Response.json({ok:true,message:"Destinatário removido. O histórico de envios foi preservado."});}
  catch(error){console.error("[whatsapp.delete]",error);return Response.json({error:"Não foi possível remover o destinatário."},{status:500});}
}
