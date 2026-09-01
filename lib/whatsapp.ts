import type { D1DatabaseLike } from "../db";

type Row=Record<string,unknown>;
export type WhatsappLevel="WARNING"|"NEAR"|"OVERDUE";
export type WhatsappTrigger="AUTOMATIC"|"MANUAL"|"TEST"|"OVERDUE_REPEAT";
export type WhatsappConnectionStatus="NOT_CONFIGURED"|"CONNECTED"|"ERROR";
export type WhatsappSendMode="MANUAL"|"API";
export type WhatsappRecipient={id:number;name:string;phone:string;active:boolean;categories:string[];alertTypes:WhatsappLevel[];createdAt:string;updatedAt:string};
export type WhatsappAlertSnapshot={alertId:number;planId:number;equipmentId:number;prefix:string;category:string;brand:string;model:string;front:string;maintenanceName:string;level:WhatsappLevel;currentValue:number;lastValue:number|null;nextValue:number;remainingValue:number;unit:"HOURS"|"KM";qrToken:string|null};
export type WhatsappSettings={sendMode:WhatsappSendMode;automaticEnabled:boolean;overdueRepeatDays:number;templateName:string;templateLanguage:string};
type RuntimeEnvironment={accessToken:string;phoneNumberId:string;apiVersion:string;publicBaseUrl:string;cronSecret:string;webhookVerifyToken:string;appSecret:string;encryptionKey:string};
type ConnectionRow={connectionName:string;senderPhone:string;phoneNumberId:string;wabaId:string;accessTokenEncrypted:string;apiVersion:string;status:WhatsappConnectionStatus;lastError:string;lastTestedAt:string};
type ProviderCredentials=ConnectionRow&{accessToken:string;hasAccessToken:boolean;encryptionReady:boolean;publicBaseUrl:string};

const allowedLevels:WhatsappLevel[]=["WARNING","NEAR","OVERDUE"];
const defaultSettings:WhatsappSettings={sendMode:"MANUAL",automaticEnabled:false,overdueRepeatDays:0,templateName:"",templateLanguage:"pt_BR"};
const formatter=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1});
function clean(value:unknown){return typeof value==="string"?value.trim():"";}
function parseList(value:unknown,fallback:string[]){try{const parsed=JSON.parse(String(value??""));return Array.isArray(parsed)?parsed.map(String):fallback;}catch{return fallback;}}
export function normalizeWhatsappPhone(value:unknown){const digits=clean(value).replace(/\D/g,"");if(digits.length===10||digits.length===11)return `55${digits}`;return digits;}
export function validBrazilWhatsappPhone(value:unknown){return /^55\d{10,11}$/.test(normalizeWhatsappPhone(value));}
function categoryOf(prefix:string){return prefix.trim().toUpperCase().split("-")[0];}
function statusLabel(level:WhatsappLevel){return level==="WARNING"?"PRÓXIMA TROCA":level==="NEAR"?"URGENTE":"VENCIDA";}
function resultLabel(value:string){return value==="SENT"?"ENVIADO":value==="DELIVERED"?"ENTREGUE":value==="FAILED"?"FALHOU":"PENDENTE";}
function maskToken(value:string){return value?`${value.slice(0,6)}${"•".repeat(Math.min(20,Math.max(8,value.length-10)))}${value.slice(-4)}`:"";}

async function runtimeEnvironment():Promise<RuntimeEnvironment>{
  const values=process.env as unknown as Record<string,unknown>;
  return {accessToken:clean(values.WHATSAPP_ACCESS_TOKEN),phoneNumberId:clean(values.WHATSAPP_PHONE_NUMBER_ID),apiVersion:clean(values.WHATSAPP_API_VERSION)||"v23.0",publicBaseUrl:(clean(values.WHATSAPP_PUBLIC_BASE_URL)||"https://www.jcsistema.online").replace(/\/$/,""),cronSecret:clean(values.WHATSAPP_CRON_SECRET),webhookVerifyToken:clean(values.WHATSAPP_WEBHOOK_VERIFY_TOKEN),appSecret:clean(values.WHATSAPP_APP_SECRET),encryptionKey:clean(values.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY)};
}
function bytesToBase64(bytes:Uint8Array){let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
function base64ToBytes(value:string){const binary=atob(value);return Uint8Array.from(binary,(character)=>character.charCodeAt(0));}
async function encryptionCryptoKey(secret:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret));return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["encrypt","decrypt"]);}
async function encryptAccessToken(token:string,secret:string){if(!secret)throw new Error("Configure WHATSAPP_CREDENTIALS_ENCRYPTION_KEY no backend antes de salvar o token.");const iv=crypto.getRandomValues(new Uint8Array(12));const key=await encryptionCryptoKey(secret);const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(token)));return `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;}
async function decryptAccessToken(payload:string,secret:string){if(!payload||!secret)return "";const [ivPart,dataPart]=payload.split(".");if(!ivPart||!dataPart)return "";const key=await encryptionCryptoKey(secret);const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:base64ToBytes(ivPart)},key,base64ToBytes(dataPart));return new TextDecoder().decode(decrypted);}

async function connectionRow(d1:D1DatabaseLike):Promise<ConnectionRow>{
  const row=await d1.prepare(`SELECT connection_name,sender_phone,phone_number_id,waba_id,access_token_encrypted,api_version,connection_status,last_connection_error,last_tested_at FROM whatsapp_settings WHERE id=1`).first<Row>();
  return {connectionName:clean(row?.connection_name),senderPhone:clean(row?.sender_phone),phoneNumberId:clean(row?.phone_number_id),wabaId:clean(row?.waba_id),accessTokenEncrypted:clean(row?.access_token_encrypted),apiVersion:clean(row?.api_version)||"v23.0",status:(clean(row?.connection_status)||"NOT_CONFIGURED") as WhatsappConnectionStatus,lastError:clean(row?.last_connection_error),lastTestedAt:clean(row?.last_tested_at)};
}
async function providerCredentials(d1:D1DatabaseLike):Promise<ProviderCredentials>{
  const [row,runtime]=await Promise.all([connectionRow(d1),runtimeEnvironment()]);let storedToken="";
  if(row.accessTokenEncrypted&&runtime.encryptionKey){try{storedToken=await decryptAccessToken(row.accessTokenEncrypted,runtime.encryptionKey);}catch{storedToken="";}}
  const accessToken=storedToken||runtime.accessToken;
  return {...row,accessToken,hasAccessToken:Boolean(accessToken),phoneNumberId:row.phoneNumberId||runtime.phoneNumberId,apiVersion:row.apiVersion||runtime.apiVersion,encryptionReady:Boolean(runtime.encryptionKey),publicBaseUrl:runtime.publicBaseUrl};
}

export async function getWhatsappSettings(d1:D1DatabaseLike):Promise<WhatsappSettings>{
  const row=await d1.prepare(`SELECT send_mode,automatic_enabled,overdue_repeat_days,template_name,template_language FROM whatsapp_settings WHERE id=1`).first<Row>();
  if(!row)return defaultSettings;
  const sendMode=clean(row.send_mode)==="API"?"API":"MANUAL";
  return {sendMode,automaticEnabled:sendMode==="API"&&Number(row.automatic_enabled)===1,overdueRepeatDays:Number(row.overdue_repeat_days??0),templateName:clean(row.template_name),templateLanguage:clean(row.template_language)||"pt_BR"};
}
export async function getWhatsappConfiguration(d1:D1DatabaseLike){
  const [settings,runtime,connection]=await Promise.all([getWhatsappSettings(d1),runtimeEnvironment(),providerCredentials(d1)]);
  const requirements={accessToken:connection.hasAccessToken,phoneNumberId:Boolean(connection.phoneNumberId),wabaId:Boolean(connection.wabaId),approvedTemplate:Boolean(settings.templateName),schedulerSecret:Boolean(runtime.cronSecret),webhookVerifyToken:Boolean(runtime.webhookVerifyToken),appSecret:Boolean(runtime.appSecret)};
  const connected=connection.status==="CONNECTED"&&requirements.accessToken&&requirements.phoneNumberId&&requirements.wabaId;
  return {provider:"Meta WhatsApp Cloud API",configured:settings.sendMode==="MANUAL"||Boolean(connected&&requirements.approvedTemplate),connected,requirements,settings,connection:{name:connection.connectionName,senderPhone:connection.senderPhone,phoneNumberId:connection.phoneNumberId,wabaId:connection.wabaId,apiVersion:connection.apiVersion,status:connection.status,lastError:connection.lastError,lastTestedAt:connection.lastTestedAt,maskedAccessToken:maskToken(connection.accessToken),hasAccessToken:connection.hasAccessToken,encryptionReady:connection.encryptionReady}};
}
export async function saveWhatsappConnection(d1:D1DatabaseLike,input:{connectionName:unknown;senderPhone:unknown;phoneNumberId:unknown;wabaId:unknown;accessToken:unknown;apiVersion:unknown}){
  const current=await connectionRow(d1);const runtime=await runtimeEnvironment();const connectionName=clean(input.connectionName);const senderPhone=normalizeWhatsappPhone(input.senderPhone);const phoneNumberId=clean(input.phoneNumberId);const wabaId=clean(input.wabaId);const accessToken=clean(input.accessToken);const apiVersion=clean(input.apiVersion)||"v23.0";
  if(!connectionName)return {error:"Informe um nome para a conexão."};
  if(!validBrazilWhatsappPhone(senderPhone))return {error:"Informe o número remetente no formato 55 + DDD + número, somente dígitos."};
  if(!/^\d+$/.test(phoneNumberId))return {error:"Informe um Phone Number ID válido, somente com números."};
  if(!/^\d+$/.test(wabaId))return {error:"Informe um WABA ID válido, somente com números."};
  if(!/^v\d+\.\d+$/.test(apiVersion))return {error:"Informe a versão da API no formato v23.0."};
  if(!accessToken&&!current.accessTokenEncrypted&&!runtime.accessToken)return {error:"Informe o Access Token da Meta."};
  let encrypted=current.accessTokenEncrypted;if(accessToken){try{encrypted=await encryptAccessToken(accessToken,runtime.encryptionKey);}catch(error){return {error:error instanceof Error?error.message:"Não foi possível proteger o token."};}}
  const now=new Date().toISOString();
  await d1.prepare(`INSERT INTO whatsapp_settings (id,connection_name,sender_phone,phone_number_id,waba_id,access_token_encrypted,api_version,connection_status,last_connection_error,last_tested_at,created_at,updated_at)
    VALUES (1,?,?,?,?,?,?,'NOT_CONFIGURED',NULL,NULL,?,?) ON CONFLICT(id) DO UPDATE SET connection_name=excluded.connection_name,sender_phone=excluded.sender_phone,phone_number_id=excluded.phone_number_id,waba_id=excluded.waba_id,access_token_encrypted=excluded.access_token_encrypted,api_version=excluded.api_version,connection_status='NOT_CONFIGURED',last_connection_error=NULL,last_tested_at=NULL,updated_at=excluded.updated_at`)
    .bind(connectionName,senderPhone,phoneNumberId,wabaId,encrypted||null,apiVersion,now,now).run();
  return {ok:true,message:"Dados protegidos no backend. Teste a conexão para ativar os envios."};
}

type GraphError={error?:{message?:string;error_user_msg?:string;code?:number;error_subcode?:number}};
async function graphGet<T>(credentials:ProviderCredentials,path:string):Promise<T>{
  const response=await fetch(`https://graph.facebook.com/${credentials.apiVersion}/${path}`,{headers:{Authorization:`Bearer ${credentials.accessToken}`}});const data=await response.json().catch(()=>({})) as T&GraphError;
  if(!response.ok){const reason=data.error?.error_user_msg||data.error?.message||`A Meta recusou a consulta (${response.status}).`;throw new Error(`${reason}${data.error?.code?` [código ${data.error.code}${data.error.error_subcode?`/${data.error.error_subcode}`:""}]`:""}`);}return data;
}
export async function testWhatsappConnection(d1:D1DatabaseLike){
  const credentials=await providerCredentials(d1);const now=new Date().toISOString();
  const fail=async(error:unknown)=>{const reason=error instanceof Error?error.message:"Falha desconhecida ao validar a Meta.";await d1.prepare(`UPDATE whatsapp_settings SET connection_status='ERROR',last_connection_error=?,last_tested_at=?,updated_at=? WHERE id=1`).bind(reason,now,now).run();return {ok:false as const,error:reason};};
  try{
    if(!credentials.hasAccessToken||!credentials.phoneNumberId||!credentials.wabaId)throw new Error("Preencha Access Token, Phone Number ID e WABA ID antes de testar.");
    const phone=await graphGet<{id?:string;display_phone_number?:string;verified_name?:string;quality_rating?:string}>(credentials,`${credentials.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`);
    await graphGet(credentials,`${credentials.wabaId}?fields=id,name`);
    const numbers=await graphGet<{data?:Array<{id?:string;display_phone_number?:string}>}>(credentials,`${credentials.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`);
    if(!numbers.data?.some((item)=>String(item.id)===credentials.phoneNumberId))throw new Error("O Phone Number ID informado não pertence ao WABA ID cadastrado.");
    const verifiedPhone=normalizeWhatsappPhone(phone.display_phone_number);if(credentials.senderPhone&&verifiedPhone&&credentials.senderPhone!==verifiedPhone)throw new Error(`O número remetente informado não corresponde ao número validado pela Meta (${verifiedPhone}).`);
    await d1.prepare(`UPDATE whatsapp_settings SET sender_phone=?,connection_status='CONNECTED',last_connection_error=NULL,last_tested_at=?,updated_at=? WHERE id=1`).bind(verifiedPhone||credentials.senderPhone,now,now).run();
    return {ok:true as const,message:`Conexão validada com a Meta${phone.verified_name?` para ${phone.verified_name}`:""}.`,senderPhone:verifiedPhone||credentials.senderPhone,qualityRating:phone.quality_rating??null};
  }catch(error){return fail(error);}
}

export async function listWhatsappRecipients(d1:D1DatabaseLike):Promise<WhatsappRecipient[]>{
  const result=await d1.prepare(`SELECT id,name,phone,active,categories,alert_types,created_at,updated_at FROM whatsapp_recipients ORDER BY active DESC,name`).all<Row>();
  return result.results.map((row)=>({id:Number(row.id),name:String(row.name),phone:String(row.phone),active:Number(row.active)===1,categories:parseList(row.categories,["ALL"]),alertTypes:parseList(row.alert_types,allowedLevels).filter((item):item is WhatsappLevel=>allowedLevels.includes(item as WhatsappLevel)),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}));
}
export async function loadWhatsappAlerts(d1:D1DatabaseLike,options:{equipmentId?:number;planIds?:number[]}={}):Promise<WhatsappAlertSnapshot[]>{
  const where=[`a.status='OPEN'`,`a.level IN ('WARNING','NEAR','OVERDUE')`,`p.active=1`,`emt.applicable=1`,`e.oil_change_enabled=1`];const bindings:unknown[]=[];
  if(options.equipmentId){where.push("a.equipment_id=?");bindings.push(options.equipmentId);}if(options.planIds?.length){where.push(`a.plan_id IN (${options.planIds.map(()=>"?").join(",")})`);bindings.push(...options.planIds);}
  const result=await d1.prepare(`SELECT a.id AS alert_id,a.plan_id,a.equipment_id,a.level,a.control_type,a.current_value,a.planned_value,a.remaining_value,e.prefix,e.brand,e.model,e.qr_token,COALESCE(sf.name,'Sem frente') AS front,t.name AS maintenance_name,p.last_hours,p.last_km
    FROM alerts a INNER JOIN equipment e ON e.id=a.equipment_id LEFT JOIN service_fronts sf ON sf.id=e.service_front_id INNER JOIN maintenance_plans p ON p.id=a.plan_id INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id
    INNER JOIN equipment_maintenance_types emt ON emt.equipment_id=p.equipment_id AND emt.maintenance_type_id=p.maintenance_type_id WHERE ${where.join(" AND ")} ORDER BY a.id`).bind(...bindings).all<Row>();
  return result.results.map((row)=>({alertId:Number(row.alert_id),planId:Number(row.plan_id),equipmentId:Number(row.equipment_id),prefix:String(row.prefix),category:categoryOf(String(row.prefix)),brand:String(row.brand??""),model:String(row.model??""),front:String(row.front??"Sem frente"),maintenanceName:String(row.maintenance_name),level:String(row.level) as WhatsappLevel,currentValue:Number(row.current_value),lastValue:row.control_type==="KM"?(row.last_km===null?null:Number(row.last_km)):(row.last_hours===null?null:Number(row.last_hours)),nextValue:Number(row.planned_value),remainingValue:Number(row.remaining_value),unit:String(row.control_type) as "HOURS"|"KM",qrToken:row.qr_token===null?null:String(row.qr_token)}));
}
function recipientMatches(recipient:WhatsappRecipient,alert:WhatsappAlertSnapshot){return recipient.active&&(recipient.categories.includes("ALL")||recipient.categories.includes(alert.category))&&recipient.alertTypes.includes(alert.level);}
export async function buildWhatsappMessage(alert:WhatsappAlertSnapshot){
  const runtime=await runtimeEnvironment();const suffix=alert.unit==="KM"?"km":"h";const overdue=alert.level==="OVERDUE"||alert.level==="NEAR";
  const title=alert.level==="NEAR"?"🚨 *MANUTENÇÃO URGENTE*":alert.level==="OVERDUE"?"🔴 *MANUTENÇÃO VENCIDA*":"🔧 *ALERTA DE MANUTENÇÃO*";
  const balance=overdue?`Vencido há: *${formatter.format(Math.abs(alert.remainingValue))} ${suffix}*`:`Restam: *${formatter.format(alert.remainingValue)} ${suffix}*`;
  const guidance=alert.level==="NEAR"?"A manutenção ultrapassou significativamente o limite programado. Providenciar atendimento com prioridade.":alert.level==="OVERDUE"?"Favor providenciar a manutenção.":"Favor programar a manutenção preventiva.";
  const link=alert.qrToken?`\n\n*Acessar manutenção do equipamento:*\n${runtime.publicBaseUrl}/equipamento/qr/${alert.qrToken}`:"";
  const equipmentModel=[alert.brand,alert.model].filter(Boolean).join(" ")||"Não informado";
  return `${title}\n\nEquipamento: *${alert.prefix}*\nModelo: *${equipmentModel}*\nManutenção: *${alert.maintenanceName}*\nFrente: *${alert.front}*\n\n${alert.unit==="KM"?"Quilometragem":"Horímetro"} atual: *${formatter.format(alert.currentValue)} ${suffix}*\nÚltima troca: *${alert.lastValue===null?"Não informada":`${formatter.format(alert.lastValue)} ${suffix}`}*\nPróxima troca: *${formatter.format(alert.nextValue)} ${suffix}*\n\nStatus: *${statusLabel(alert.level)}*\n${balance}\n\n${guidance}\n\nSistema de Manutenção Preventiva - JC Serviços Florestais${link}`;
}

export async function prepareManualWhatsappAlerts(d1:D1DatabaseLike,planIds:number[]){
  const [recipients,alerts]=await Promise.all([listWhatsappRecipients(d1),loadWhatsappAlerts(d1,{planIds})]);
  const preparedAlerts=await Promise.all(alerts.map(async(alert)=>({planId:alert.planId,prefix:alert.prefix,maintenanceName:alert.maintenanceName,level:alert.level,status:statusLabel(alert.level),message:await buildWhatsappMessage(alert)})));
  const preparedRecipients=recipients.filter((recipient)=>alerts.some((alert)=>recipientMatches(recipient,alert))).map((recipient)=>({id:recipient.id,name:recipient.name,phone:recipient.phone,matchingPlanIds:alerts.filter((alert)=>recipientMatches(recipient,alert)).map((alert)=>alert.planId)}));
  return {alerts:preparedAlerts,recipients:preparedRecipients};
}

async function sendMetaMessage(d1:D1DatabaseLike,to:string,message:string,settings:WhatsappSettings,alert?:WhatsappAlertSnapshot){
  const credentials=await providerCredentials(d1);if(credentials.status!=="CONNECTED"||!credentials.accessToken||!credentials.phoneNumberId)throw new Error("Envio não realizado: integração WhatsApp não configurada.");const automatic=Boolean(alert);let body:Record<string,unknown>;
  if(automatic){if(!settings.templateName)throw new Error("Cadastre o nome de um modelo de mensagem aprovado pela Meta.");const suffix=alert!.unit==="KM"?"km":"h";const link=alert!.qrToken?`${credentials.publicBaseUrl}/equipamento/qr/${alert!.qrToken}`:credentials.publicBaseUrl;body={messaging_product:"whatsapp",to,type:"template",template:{name:settings.templateName,language:{code:settings.templateLanguage},components:[{type:"body",parameters:[alert!.prefix,alert!.maintenanceName,`${formatter.format(alert!.currentValue)} ${suffix}`,alert!.lastValue===null?"Não informada":`${formatter.format(alert!.lastValue)} ${suffix}`,`${formatter.format(alert!.nextValue)} ${suffix}`,`${formatter.format(Math.abs(alert!.remainingValue))} ${suffix}`,statusLabel(alert!.level),link].map((text)=>({type:"text",text}))}]}};}
  else body={messaging_product:"whatsapp",recipient_type:"individual",to,type:"text",text:{preview_url:false,body:message}};
  const response=await fetch(`https://graph.facebook.com/${credentials.apiVersion}/${credentials.phoneNumberId}/messages`,{method:"POST",headers:{Authorization:`Bearer ${credentials.accessToken}`,"Content-Type":"application/json"},body:JSON.stringify(body)});const data=await response.json().catch(()=>({})) as {messages?:Array<{id?:string}>;error?:{message?:string;error_user_msg?:string;code?:number}};
  if(!response.ok)throw new Error(`${data.error?.error_user_msg||data.error?.message||`A Meta recusou o envio (${response.status}).`}${data.error?.code?` [código ${data.error.code}]`:""}`);return data.messages?.[0]?.id??null;
}
async function reserveDelivery(d1:D1DatabaseLike,alert:WhatsappAlertSnapshot,recipient:WhatsappRecipient,message:string,trigger:WhatsappTrigger,dedupeKey:string|null,createdBy:number|null){
  const now=new Date().toISOString();await d1.prepare(`INSERT INTO whatsapp_deliveries (alert_id,plan_id,equipment_id,recipient_id,equipment_prefix,category,maintenance_name,alert_status,current_value,last_value,next_value,remaining_value,unit,recipient_name,recipient_phone,message,result,trigger_type,dedupe_key,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING',?,?,?,?,?) ON CONFLICT (dedupe_key) DO NOTHING`).bind(alert.alertId,alert.planId,alert.equipmentId,recipient.id,alert.prefix,alert.category,alert.maintenanceName,alert.level,alert.currentValue,alert.lastValue,alert.nextValue,alert.remainingValue,alert.unit,recipient.name,recipient.phone,message,trigger,dedupeKey,createdBy,now,now).run();
  if(!dedupeKey){const row=await d1.prepare(`SELECT id FROM whatsapp_deliveries WHERE created_at=? AND recipient_id=? ORDER BY id DESC LIMIT 1`).bind(now,recipient.id).first<Row>();return row?Number(row.id):null;}const row=await d1.prepare(`SELECT id,created_at FROM whatsapp_deliveries WHERE dedupe_key=?`).bind(dedupeKey).first<Row>();return row&&String(row.created_at)===now?Number(row.id):null;
}
async function completeDelivery(d1:D1DatabaseLike,id:number,result:"SENT"|"FAILED",providerMessageId:string|null,errorReason:string|null){const now=new Date().toISOString();await d1.prepare(`UPDATE whatsapp_deliveries SET result=?,provider_message_id=?,error_reason=?,sent_at=?,updated_at=? WHERE id=?`).bind(result,providerMessageId,errorReason,result==="SENT"?now:null,now,id).run();}
export async function sendWhatsappAlert(d1:D1DatabaseLike,alert:WhatsappAlertSnapshot,recipient:WhatsappRecipient,options:{trigger:WhatsappTrigger;dedupeKey?:string|null;createdBy?:number|null}){
  const settings=await getWhatsappSettings(d1);const message=await buildWhatsappMessage(alert);const id=await reserveDelivery(d1,alert,recipient,message,options.trigger,options.dedupeKey??null,options.createdBy??null);if(id===null)return {skipped:true,result:"PENDING" as const};
  try{const useTemplate=options.trigger==="AUTOMATIC"||options.trigger==="OVERDUE_REPEAT"||(options.trigger==="MANUAL"&&Boolean(settings.templateName));const providerMessageId=await sendMetaMessage(d1,recipient.phone,message,settings,useTemplate?alert:undefined);await completeDelivery(d1,id,"SENT",providerMessageId,null);return {skipped:false,result:"SENT" as const,providerMessageId};}catch(error){const reason=error instanceof Error?error.message:"Falha desconhecida na integração.";await completeDelivery(d1,id,"FAILED",null,reason);return {skipped:false,result:"FAILED" as const,error:reason};}
}
export async function processAutomaticWhatsappAlerts(d1:D1DatabaseLike,options:{equipmentId?:number;repeatOnly?:boolean}={}){
  const [settings,configuration]=await Promise.all([getWhatsappSettings(d1),getWhatsappConfiguration(d1)]);if(settings.sendMode!=="API")return {processed:0,sent:0,failed:0,skipped:"manual_mode"};if(!settings.automaticEnabled)return {processed:0,sent:0,failed:0,skipped:"disabled"};if(!configuration.configured)return {processed:0,sent:0,failed:0,skipped:"not_configured",message:"Envio não realizado: integração WhatsApp não configurada."};
  const [recipients,alerts]=await Promise.all([listWhatsappRecipients(d1),loadWhatsappAlerts(d1,{equipmentId:options.equipmentId})]);let processed=0,sent=0,failed=0;
  for(const alert of alerts)for(const recipient of recipients){if(!recipientMatches(recipient,alert))continue;const cycle=`PLAN:${alert.planId}:RECIPIENT:${recipient.id}:STATUS:${alert.level}:NEXT:${alert.nextValue}`;let trigger:WhatsappTrigger="AUTOMATIC",dedupeKey=cycle;if(options.repeatOnly){if(alert.level!=="OVERDUE"||settings.overdueRepeatDays<=0)continue;const latest=await d1.prepare(`SELECT created_at FROM whatsapp_deliveries WHERE plan_id=? AND recipient_id=? AND alert_status='OVERDUE' AND next_value=? ORDER BY created_at DESC LIMIT 1`).bind(alert.planId,recipient.id,alert.nextValue).first<Row>();if(!latest||Date.now()-new Date(String(latest.created_at)).getTime()<settings.overdueRepeatDays*86400000)continue;trigger="OVERDUE_REPEAT";dedupeKey=`${cycle}:REPEAT:${new Date().toISOString().slice(0,10)}`;}const result=await sendWhatsappAlert(d1,alert,recipient,{trigger,dedupeKey});if(result.skipped)continue;processed++;if(result.result==="SENT")sent++;else failed++;}
  return {processed,sent,failed};
}
export async function sendManualWhatsappAlerts(d1:D1DatabaseLike,planIds:number[],createdBy:number){if(!(await getWhatsappConfiguration(d1)).connected)throw new Error("Envio não realizado: integração WhatsApp não configurada.");const [recipients,alerts]=await Promise.all([listWhatsappRecipients(d1),loadWhatsappAlerts(d1,{planIds})]);let processed=0,sent=0,failed=0;for(const alert of alerts)for(const recipient of recipients){if(!recipientMatches(recipient,alert))continue;const result=await sendWhatsappAlert(d1,alert,recipient,{trigger:"MANUAL",createdBy});if(result.skipped)continue;processed++;if(result.result==="SENT")sent++;else failed++;}return {processed,sent,failed,alerts:alerts.length};}
export async function sendWhatsappTest(d1:D1DatabaseLike,recipient:WhatsappRecipient,createdBy:number){
  if(!(await getWhatsappConfiguration(d1)).connected)throw new Error("Envio não realizado: integração WhatsApp não configurada.");const message="Teste de integração\n\nO sistema de Manutenção Preventiva está conectado ao WhatsApp com sucesso.";const settings=await getWhatsappSettings(d1);const now=new Date().toISOString();
  await d1.prepare(`INSERT INTO whatsapp_deliveries (recipient_id,equipment_prefix,category,maintenance_name,alert_status,recipient_name,recipient_phone,message,result,trigger_type,created_by,created_at,updated_at) VALUES (?,'SISTEMA','SISTEMA','Teste de integração','TESTE',?,?,?,'PENDING','TEST',?,?,?)`).bind(recipient.id,recipient.name,recipient.phone,message,createdBy,now,now).run();const row=await d1.prepare(`SELECT id FROM whatsapp_deliveries WHERE recipient_id=? AND trigger_type='TEST' AND created_at=? ORDER BY id DESC LIMIT 1`).bind(recipient.id,now).first<Row>();if(!row)throw new Error("Não foi possível registrar o teste.");const id=Number(row.id);
  try{const providerMessageId=await sendMetaMessage(d1,recipient.phone,message,settings);await completeDelivery(d1,id,"SENT",providerMessageId,null);return {result:"SENT",providerMessageId};}catch(error){const reason=error instanceof Error?error.message:"Falha desconhecida na integração.";await completeDelivery(d1,id,"FAILED",null,reason);return {result:"FAILED",error:reason};}
}
export async function listWhatsappDeliveries(d1:D1DatabaseLike,limit=300){const result=await d1.prepare(`SELECT id,alert_id,plan_id,equipment_id,equipment_prefix,category,maintenance_name,alert_status,current_value,last_value,next_value,remaining_value,unit,recipient_name,recipient_phone,message,result,provider_message_id,error_reason,trigger_type,sent_at,delivered_at,created_at FROM whatsapp_deliveries ORDER BY created_at DESC,id DESC LIMIT ?`).bind(Math.max(1,Math.min(1000,limit))).all<Row>();return result.results.map((row)=>({...row,id:Number(row.id),alertId:row.alert_id===null?null:Number(row.alert_id),planId:row.plan_id===null?null:Number(row.plan_id),equipmentId:row.equipment_id===null?null:Number(row.equipment_id),equipmentPrefix:String(row.equipment_prefix),maintenanceName:String(row.maintenance_name),alertStatus:String(row.alert_status),recipientName:String(row.recipient_name),recipientPhone:String(row.recipient_phone),providerMessageId:row.provider_message_id===null?null:String(row.provider_message_id),errorReason:row.error_reason===null?null:String(row.error_reason),triggerType:String(row.trigger_type),result:String(row.result),resultLabel:resultLabel(String(row.result)),createdAt:String(row.created_at)}));}
export async function getWhatsappCronSecret(){return (await runtimeEnvironment()).cronSecret;}
export async function getWhatsappWebhookEnvironment(){const runtime=await runtimeEnvironment();return {verifyToken:runtime.webhookVerifyToken,appSecret:runtime.appSecret};}
