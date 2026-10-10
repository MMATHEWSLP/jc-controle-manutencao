import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { siteHosts } from "./site";
import { getDb } from "../db";
import { auditLogs, authBootstrap, serviceFronts, taskRoles, userPermissions, userServiceFronts, userSessions, users } from "../db/schema";
import {
  ENDED_SESSION_KEEP_SECONDS, SESSION_COOKIE_SECONDS, isSessionKind, sessionEndReason, sessionExpiry, slidingRenewal,
  type RevokeReason, type SessionEndReason, type SessionKind,
} from "./session-rules";

export const SESSION_COOKIE = "maintenance_session";
// Validade das sessões: lib/session-rules.ts (campo 30 dias e "Manter conectado" 30 dias, renovando a
// cada uso; sem marcar, cai depois de 12 h sem uso).
// ÚNICAS rotas de API que uma sessão CAMPO pode chamar. Qualquer outra responde 403 em
// authorize(), mesmo que alguém tente chamar direto (não depende de esconder botão na tela).
// AVISO DE SEGURANÇA: login sem senha = quem souber nome + código entra no lugar do colega.
// Contrapartidas: bloqueio por tentativas (lib/field-auth.ts), código só em hash, acesso restrito
// a estas rotas, trocar o PIN ou inativar derruba a sessão na hora e todo registro guarda quem lançou.
// "/api/fuel/convoy/field": tela "Abastecimentos" do motorista do comboio (também exige a permissão
// fuel.convoy_register, que só existe para quem tem a opção marcada no cadastro de campo).
// /api/notifications: o sino e os avisos no celular do próprio funcionário (as rotas de ADMIN exigem permissão).
// "/api/producao/campo": lançamento da Derruba/Arraste do apontador da Produção (também exige producao.lancar,
// que só existe para quem tem users.production_register marcado). Essas rotas nunca devolvem valores em R$.
const FIELD_ALLOWED_API = ["/api/daily-records", "/api/checklists", "/api/auth/", "/api/ping", "/api/fuel/convoy/field", "/api/notifications", "/api/producao/campo"];
// Cloudflare Workers Web Crypto accepts PBKDF2 iteration counts up to 100,000.
// Keep the maximum supported cost so hashing works identically in production.
const PASSWORD_ITERATIONS = 100_000;
const INITIAL_ADMIN_USERNAME = "mathews";
const INITIAL_ADMIN_EMAIL = "mathews@manutencao.local";
const INITIAL_ADMIN_BOOTSTRAP_KEY = "PRIMARY_ADMIN_MATHEWS_V3";

export const PERMISSION_GROUPS = [
  { label:"Dashboard", items:[
    ["dashboard.view","Visualizar Dashboard"],
  ]},
  { label:"Equipamentos", items:[
    ["equipment.view","Visualizar equipamentos"],
    ["equipment.create","Cadastrar equipamento"],
    ["equipment.edit","Editar equipamento"],
    ["equipment.transfer","Pode transferir equipamentos entre frentes"],
    ["equipment.applicable_types","Alterar tipos de troca aplicáveis"],
    ["equipment.edit_plan","Alterar plano de manutenção"],
  ]},
  { label:"Horímetros / KM", items:[
    ["meter.view","Visualizar leituras"],
    ["meter.create","Registrar nova leitura"],
    ["meter.edit","Editar ou excluir leitura"],
  ]},
  { label:"Trocas / Manutenção", items:[
    ["maintenance.view","Visualizar trocas"],
    ["maintenance.create","Registrar troca de óleo"],
    ["maintenance.edit","Editar ou excluir manutenção"],
    ["maintenance.history","Visualizar histórico"],
  ]},
  { label:"Alertas", items:[
    ["alerts.view","Visualizar Central de Alertas"],
    ["alerts.share","Compartilhar alertas"],
    ["alerts.settings","Alterar configurações de alerta"],
  ]},
  { label:"WhatsApp", items:[
    ["whatsapp.view","Visualizar configurações e histórico"],
    ["whatsapp.send","Enviar alertas pelo WhatsApp"],
    ["whatsapp.manage","Gerenciar destinatários e automação"],
  ]},
  { label:"Status da Frota", items:[
    ["fleet.view","Visualizar Status da Frota"],
    ["fleet.update","Atualizar status, ocorrências e pedidos"],
    ["fleet.report","Exportar relatório diário da frota"],
  ]},
  { label:"Controle Diário", items:[
    ["daily.register","Registrar o Controle Diário do equipamento que opera"],
    ["daily.view_all","Visualizar os registros diários de todos os operadores (das frentes que enxerga)"],
    ["daily.manage","Editar e excluir registros do Controle Diário (das frentes que enxerga)"],
    ["daily.field_operators","Cadastrar funcionários de campo (login por nome + código)"],
    ["daily.front_requests","Aprovar ou recusar solicitações de mudança de frente"],
  ]},
  { label:"Solicitação de Materiais", items:[
    ["materials.view","Visualizar solicitações de materiais"],
    ["materials.request","Criar solicitação de materiais"],
    ["materials.ship","Separar e enviar materiais solicitados"],
    ["materials.manage","Visualizar todas as solicitações (todas as frentes/solicitantes)"],
  ]},
  { label:"Tarefas", items:[
    ["tasks.view","Acessar o módulo Tarefas (a visibilidade de cada tarefa é definida pela hierarquia)"],
    ["tasks.create","Criar tarefas e subtarefas"],
    ["tasks.edit","Editar, reatribuir, concluir ou excluir tarefas (quando autorizado pela hierarquia)"],
  ]},
  { label:"Produtos", items:[
    ["products.view","Visualizar produtos"],
    ["products.create","Cadastrar produto"],
    ["products.edit","Editar produto"],
    ["products.delete","Excluir produto"],
    ["products.import","Importar produtos em massa (CSV)"],
    ["products.manage_models","Gerenciar modelos de equipamento (Aplicação)"],
    ["suppliers.view","Visualizar fornecedores"],
    ["suppliers.create","Cadastrar fornecedor"],
    ["suppliers.edit","Editar fornecedor"],
    ["suppliers.delete","Excluir fornecedor"],
  ]},
  { label:"Solicitação de Pedidos (Compras)", items:[
    ["purchases.view","Visualizar solicitações de pedido de compra (todas as das frentes que enxerga, só consulta)"],
    ["purchases.request","Criar solicitação de pedido de compra"],
    ["purchases.approve","Aprovar ou recusar solicitações de pedido"],
    ["purchases.buy","Comprador: anexar orçamentos, preencher valores e enviar para pagamento"],
    ["purchases.pay","Confirmar o pagamento dos pedidos"],
    ["purchases.dispatch","Retirar/despachar as encomendas (marcar como enviado)"],
    ["purchases.manage","Cancelar solicitações de pedido e confirmar recebimentos das frentes que enxerga"],
  ]},
  { label:"Movimentação de Estoque", items:[
    ["stock.exits_view","Visualizar o histórico de movimentação (saídas de estoque)"],
    ["stock.exits_create","Lançar saída de produtos do estoque (veículo, funcionário e/ou departamento)"],
    ["stock.exits_cancel","Estornar uma saída lançada"],
    ["departments.manage","Cadastrar e editar Departamentos (lista única usada na Movimentação e nas Compras)"],
  ]},
  { label:"Ordem de Serviço", items:[
    ["work_orders.view","Visualizar ordens de serviço"],
    ["work_orders.manage","Abrir e editar O.S., lançar peças e mecânicos"],
    ["work_orders.close","Fechar e reabrir O.S."],
  ]},
  { label:"Combustível", items:[
    ["fuel.view","Visualizar saldos e histórico de combustível"],
    ["fuel.register","Registrar lançamento de combustível"],
    ["fuel.manage","Editar e excluir lançamentos de combustível"],
    ["fuel.convoy_approve","Aprovar, corrigir e rejeitar abastecimentos do comboio"],
    ["fuel.convoy_register","Registrar abastecimento do comboio (app de campo)"],
  ]},
  { label:"Terceiros", items:[
    ["third_parties.manage","Cadastrar, editar e inativar terceiros (prestadores, terceirizadas, pessoas físicas) e os veículos deles; aceitar leitura menor que a última com justificativa"],
  ]},
  { label:"Funcionários", items:[
    ["employees.view","Visualizar funcionários, transferências e afastamentos"],
    ["employees.manage","Cadastrar, editar, transferir, demitir e controlar o ciclo de folga dos funcionários"],
    ["employees.salary","Salário de carteira dos funcionários (LGPD: na prática só ADMIN vê CPF, nascimento, salário, motivos e afastamentos)"],
    ["employees.companies","Gerenciar a lista de empresas dos funcionários"],
  ]},
  { label:"Usuários", items:[
    ["users.view","Visualizar usuários"],
    ["users.create","Criar usuários"],
    ["users.edit","Editar usuários"],
    ["users.permissions","Alterar permissões"],
    ["users.status","Ativar/desativar usuários"],
  ]},
  { label:"Frentes de Serviço", items:[
    ["service_fronts.manage","Cadastrar, renomear e ativar/desativar frentes de serviço"],
  ]},
  // Menu RELATÓRIOS (lib/reports-catalog.ts): uma permissão por categoria, sempre só das frentes da pessoa.
  { label:"Relatórios", items:[
    ["reports.producao","Relatórios de Produção (Controle Diário)"],
    ["reports.combustivel","Relatórios de Combustível (entradas, saídas, terceiros, comboio, conferência com o Diário)"],
    ["reports.pecas","Relatórios de Peças e produtos (saídas e produtos com saldo)"],
    ["reports.manutencao","Relatórios de Manutenção (trocas de óleo, vencidas, status da frota)"],
    ["reports.custos","Relatórios de Custos (valores em R$ por equipamento e frente)"],
    ["reports.resumos","Resumos da operação (semanal)"],
    ["costs.other_expenses","Lançar, editar e excluir Outros gastos (serviços/mão de obra e outros) das frentes que enxerga"],
  ]},
  // Central de notificações (lib/notifications.ts). Ver e silenciar as próprias notificações não exige permissão.
  { label:"Notificações", items:[
    ["notifications.configure","Configurar notificações (eventos, destinatários) e ver o registro de envios"],
    ["notifications.send","Enviar notificação avulsa para pessoas, perfis ou frentes"],
  ]},
  // Módulo PRODUÇÃO (Derruba → Arraste → Medição → Transporte), sempre só nas frentes da pessoa. Pedido
  // explícito do administrador: só o ADMIN recebe por padrão; os demais (inclusive GESTOR) por pessoa.
  { label:"Produção", items:[
    ["producao.ver","Consultar a Produção (projetos, derruba, arraste, medição, transporte e resumo), sem valores em R$"],
    ["producao.custos","Ver custos e despesas da Produção (R$, custo por árvore, preço por m³, análises e PDFs com valores)"],
    ["producao.lancar","Lançar e corrigir (editar) derruba, arraste, medição, viagens e despesas em etapas não finalizadas"],
    ["producao.gerenciar","Gerenciar projetos, equipes, preços por frente e metas; finalizar e reabrir etapas; excluir lançamentos"],
  ]},
] as const;

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((group) => group.items.map(([key]) => key));
export type Permission = typeof ALL_PERMISSIONS[number];
export type Profile = "ADMIN" | "GESTOR" | "OFICINA" | "OPERADOR" | "ALMOXARIFADO" | "CAMPO";

// REGRA DO PROJETO (pedido explícito do administrador): ao criar uma função/permissão nova,
// NUNCA adicione a chave nos arrays de OFICINA/OPERADOR/ALMOXARIFADO (perfis de funcionário)
// nem de GESTOR sem confirmar antes — toda função nova nasce sem acesso para quem não é ADMIN,
// e é o administrador quem concede manualmente depois, por usuário, em Usuários → Permissões
// (grava um registro em user_permissions, sem alterar este padrão). Isso vale também para
// Tarefas e Materiais: os funcionários (OFICINA/ALMOXARIFADO) tiveram esse acesso padrão
// removido por pedido explícito — quem precisar, o administrador libera individualmente.
export const PROFILE_DEFAULTS: Record<Profile, Permission[]> = {
  ADMIN:[...ALL_PERMISSIONS],
  GESTOR:["dashboard.view","equipment.view","meter.view","maintenance.view","maintenance.history","alerts.view","alerts.share","whatsapp.view","whatsapp.send","fleet.view","fleet.update","fleet.report","materials.view","materials.manage","tasks.view","tasks.create","tasks.edit","products.view","products.create","products.edit","suppliers.view","suppliers.create","suppliers.edit","daily.field_operators","daily.front_requests",
    // Terceiros: o administrador pediu explicitamente que GESTOR cadastre/edite/inative terceiros.
    "third_parties.manage",
    // Aprovação do comboio: o administrador pediu explicitamente ADMIN e GESTOR (configurável por usuário).
    "fuel.convoy_approve",
    // Menu RELATÓRIOS: o administrador pediu explicitamente "ADMIN e GESTOR veem tudo" (configurável por usuário).
    "reports.producao","reports.combustivel","reports.pecas","reports.manutencao","reports.custos","reports.resumos"],
  OFICINA:["equipment.view","equipment.edit_plan","meter.view","meter.create","maintenance.view","maintenance.create","maintenance.edit","maintenance.history","alerts.view","fleet.view","fleet.update","fleet.report"],
  OPERADOR:[],
  // Fixo: o funcionário de campo só registra o Controle Diário (overrides são ignorados). O motorista
  // do comboio (setor Abastecimentos) ganha fuel.convoy_register e, se não fizer o Controle Diário
  // (users.field_daily_access = false), perde daily.register.
  CAMPO:["daily.register"],
  ALMOXARIFADO:["dashboard.view","equipment.view","meter.view","maintenance.view","maintenance.history","alerts.view","fleet.view","fleet.update","fleet.report","products.view","suppliers.view"],
};

export type SessionUser = {
  id:number;
  name:string;
  username:string;
  email:string;
  profile:Profile;
  taskRoleId:number|null;
  status:"ACTIVE"|"INACTIVE";
  theme:"LIGHT"|"DARK";
  isPrimaryAdmin:boolean;
  lastAccessAt:string|null;
  createdAt:string;
  permissions:Permission[];
  // Frente principal: padrão em formulários/relatórios, não a fonte de verdade de visibilidade.
  serviceFrontId:number|null;
  serviceFrontName:string|null;
  // TRUE = enxerga todas as frentes (ver lib/access.ts:frentesVisiveis, o único ponto que combina
  // estes três campos numa decisão de acesso — nunca decida visibilidade de frente fora dele).
  allServiceFronts:boolean;
  // Frentes vinculadas em user_service_fronts, além da principal. Lista crua — já pode incluir ou
  // não a `serviceFrontId`, conforme o que foi salvo; frentesVisiveis() é quem decide o resultado.
  serviceFrontIds:number[];
  canExport:boolean;
  jobTitle:string|null;
};

function bytesToBase64Url(bytes:Uint8Array) {
  let binary="";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}

function bytesToHex(bytes:Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2,"0")).join("");
}

function hexToBytes(value:string) {
  const bytes=new Uint8Array(value.length/2);
  for(let index=0;index<bytes.length;index++) bytes[index]=Number.parseInt(value.slice(index*2,index*2+2),16);
  return bytes;
}

export function newSalt() {
  const bytes=new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function passwordHash(password:string,salt:string) {
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:new TextEncoder().encode(salt),iterations:PASSWORD_ITERATIONS},material,256);
  return bytesToHex(new Uint8Array(bits));
}

export async function verifyPassword(password:string,salt:string,expected:string) {
  const actual=hexToBytes(await passwordHash(password,salt));
  const target=hexToBytes(expected);
  if(actual.length!==target.length)return false;
  let difference=0;
  for(let index=0;index<actual.length;index++) difference|=actual[index]^target[index];
  return difference===0;
}

async function tokenHash(token:string) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

function readCookie(request:Request,name:string) {
  const cookie=request.headers.get("cookie")??"";
  for(const part of cookie.split(";")){
    const [key,...value]=part.trim().split("=");
    if(key===name)return decodeURIComponent(value.join("="));
  }
  return "";
}

export function assertSameOrigin(request:Request) {
  const origin=request.headers.get("origin");
  // Sem Origin: não é um navegador fazendo requisição entre sites (os navegadores sempre mandam
  // Origin em POST/PUT/DELETE). O cookie SameSite=Strict também impede o envio a partir de outro site.
  if(!origin)return true;
  let originHost:string;
  try{ originHost=new URL(origin).host.toLowerCase(); }catch{ return false; }
  // Atrás do proxy da Hostinger o Node pode enxergar a si mesmo como "localhost:porta"; por isso o
  // domínio oficial (SITE_URL, com e sem www) é sempre aceito. O host da própria requisição cobre o
  // uso local. X-Forwarded-Host NÃO entra: é um cabeçalho que o cliente pode inventar.
  const candidatos=[...siteHosts(),request.headers.get("host"),new URL(request.url).host];
  const ok=candidatos.some((candidato)=>Boolean(candidato)&&candidato!.toLowerCase()===originHost);
  // Registro para investigar recusas vindas do app instalado ou do proxy da Hostinger.
  if(!ok)console.warn("[auth.origin] Requisição recusada",{origin,host:request.headers.get("host"),forwardedHost:request.headers.get("x-forwarded-host"),path:new URL(request.url).pathname});
  return ok;
}

// Persistente (Max-Age): no iPhone, cookie sem validade é apagado quando o app da tela de início
// é fechado. Lax (e não Strict) para o login valer ao abrir o sistema por link do WhatsApp ou QR;
// os POSTs continuam protegidos por assertSameOrigin. Sem Domain: o endereço sem "www" é
// redirecionado para o oficial (next.config.ts), então o cookie fica num domínio só.
export function sessionCookie(token:string,seconds=SESSION_COOKIE_SECONDS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

type Db=Awaited<ReturnType<typeof getDb>>;
type DbOrTx=Db|Parameters<Parameters<Db["transaction"]>[0]>[0];

// Publicado antes da migração 0053 (colunas kind/revoked_at/... ainda não existem): o login segue
// funcionando do jeito antigo até a migração rodar.
function missingColumn(error:unknown) {
  const code=(error as {code?:string;cause?:{code?:string}})?.code??(error as {cause?:{code?:string}})?.cause?.code;
  return code==="42703";
}

export async function createSession(userId:number,kind:SessionKind) {
  const tokenBytes=new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token=bytesToBase64Url(tokenBytes);
  const now=new Date();
  const db=await getDb();
  // Faxina: sessões vencidas ou encerradas há mais de 30 dias (até lá ficam para o log do motivo).
  const keepUntil=new Date(now.getTime()-ENDED_SESSION_KEEP_SECONDS*1000).toISOString();
  const values={id:crypto.randomUUID(),userId,tokenHash:await tokenHash(token),kind,expiresAt:sessionExpiry(kind,now),lastSeenAt:now.toISOString()};
  try{
    await db.delete(userSessions).where(or(lt(userSessions.expiresAt,keepUntil),lt(userSessions.revokedAt,keepUntil)));
    await db.insert(userSessions).values(values);
  }catch(error){
    if(!missingColumn(error))throw error;
    // SQL direto: o insert do Drizzle cita todas as colunas do schema (inclusive as que faltam).
    await db.delete(userSessions).where(lt(userSessions.expiresAt,now.toISOString()));
    await db.execute(sql`insert into user_sessions (id, user_id, token_hash, expires_at, last_seen_at) values (${values.id}, ${values.userId}, ${values.tokenHash}, ${values.expiresAt}, ${values.lastSeenAt})`);
  }
  return token;
}

// Encerra as sessões abertas de um usuário (PIN/senha trocados, acesso inativado). A linha fica com
// o motivo: quando o celular dele chamar o servidor de novo, o log diz por que caiu no login.
export async function revokeUserSessions(db:DbOrTx,userId:number,reason:RevokeReason) {
  const now=new Date().toISOString();
  try{await db.update(userSessions).set({revokedAt:now,revokeReason:reason,updatedAt:now}).where(and(eq(userSessions.userId,userId),isNull(userSessions.revokedAt)));}
  catch(error){if(!missingColumn(error))throw error;await db.delete(userSessions).where(eq(userSessions.userId,userId));}
}

// Botão Sair.
export async function destroySession(request:Request) {
  const token=readCookie(request,SESSION_COOKIE);
  if(!token)return;
  const db=await getDb();
  const now=new Date().toISOString();
  // Saiu por conta própria: o fim já fica registrado (LOGOUT), sem outra linha no log depois.
  const hash=await tokenHash(token);
  try{await db.update(userSessions).set({revokedAt:now,revokeReason:"LOGOUT",endLoggedAt:now,updatedAt:now}).where(and(eq(userSessions.tokenHash,hash),isNull(userSessions.revokedAt)));}
  catch(error){if(!missingColumn(error))throw error;await db.delete(userSessions).where(eq(userSessions.tokenHash,hash));}
}

export async function effectivePermissions(userId:number,profile:Profile) {
  if(profile==="ADMIN")return resolvePermissions(profile,[]);
  const db=await getDb();
  if(profile==="CAMPO"){
    // Antes das migrações 0051/0052 as colunas não existem: o acesso de campo segue só com o Controle Diário.
    const row=(await db.select({convoy:users.convoyFuelRegister,daily:users.fieldDailyAccess}).from(users).where(eq(users.id,userId)).limit(1).catch(()=>[]))[0];
    // Apontador da Produção: consulta separada para não derrubar o comboio antes da migração 0058.
    const production=(await db.select({value:users.productionRegister}).from(users).where(eq(users.id,userId)).limit(1).catch(()=>[]))[0];
    return resolvePermissions(profile,[],{convoy:Boolean(row?.convoy),daily:Boolean(row?.daily),production:Boolean(production?.value)});
  }
  const overrides=await db.select({permission:userPermissions.permission,enabled:userPermissions.enabled}).from(userPermissions).where(eq(userPermissions.userId,userId));
  return resolvePermissions(profile,overrides);
}

// Mesma regra de effectivePermissions sem consultar o banco: usada para descobrir de uma vez quem tem
// uma permissão (destinatários de notificação, lib/notifications.ts).
// CAMPO: sem comboio nem Produção, só o Controle Diário. Motorista do comboio e apontador da Produção fazem o
// Controle Diário só se users.field_daily_access estiver marcado.
export function resolvePermissions(profile:Profile,overrides:readonly {permission:string;enabled:boolean}[],campo?:{convoy:boolean;daily:boolean;production?:boolean}):Permission[] {
  if(profile==="ADMIN")return [...ALL_PERMISSIONS];
  if(profile==="CAMPO"){
    if(!campo?.convoy&&!campo?.production)return [...PROFILE_DEFAULTS.CAMPO];
    return [...(campo.daily?PROFILE_DEFAULTS.CAMPO:[]),...(campo.convoy?["fuel.convoy_register" as Permission]:[]),...(campo.production?["producao.lancar" as Permission]:[])];
  }
  const values=new Set<Permission>(PROFILE_DEFAULTS[profile]??[]);
  for(const row of overrides){
    if(!ALL_PERMISSIONS.includes(row.permission as Permission))continue;
    if(row.enabled)values.add(row.permission as Permission);else values.delete(row.permission as Permission);
  }
  return [...values];
}

export async function userServiceFrontIds(userId:number) {
  const db=await getDb();
  const rows=await db.select({serviceFrontId:userServiceFronts.serviceFrontId}).from(userServiceFronts).where(eq(userServiceFronts.userId,userId));
  return rows.map((row)=>row.serviceFrontId);
}

export type SessionLookup = { user:SessionUser|null; token:string|null; ended:SessionEndReason|null };

// Token desconhecido (cookie velho, sessão já apagada pela faxina): registra no máximo uma vez por hora.
const unknownTokenLogged=new Map<string,number>();

async function logSessionEnd(db:Db,request:Request,reason:SessionEndReason,session:{id:string;userId:number;kind:string|null;expiresAt:string;revokedAt:string|null}|null,hash:string) {
  try{
    const now=new Date().toISOString();
    if(session){
      // Uma vez só por sessão (vários pedidos chegando juntos com o mesmo cookie).
      const first=await db.update(userSessions).set({endLoggedAt:now}).where(and(eq(userSessions.id,session.id),isNull(userSessions.endLoggedAt))).returning({id:userSessions.id});
      if(!first.length)return;
    }else{
      const last=unknownTokenLogged.get(hash);
      if(last&&Date.now()-last<3_600_000)return;
      if(unknownTokenLogged.size>500)unknownTokenLogged.clear();
      unknownTokenLogged.set(hash,Date.now());
    }
    const detail={motivo:reason,tipo:session?.kind??null,validade:session?.expiresAt??null,revogadaEm:session?.revokedAt??null,
      aparelho:(request.headers.get("user-agent")??"").slice(0,200),modo:request.headers.get("x-jc-display")?.slice(0,20)??null,rota:new URL(request.url).pathname};
    console.info("[auth.session.end]",{userId:session?.userId??null,...detail});
    await db.insert(auditLogs).values({userId:session?.userId??null,entityType:"USER",entityId:String(session?.userId??0),action:"SESSAO_ENCERRADA",newValue:JSON.stringify(detail)});
  }catch(error){console.error("[auth.session.end] Falha ao registrar",error);}
}

// Lê a sessão do cookie, renova a validade (sessão deslizante) e, se a sessão não vale mais, diz
// o motivo (e registra no log). Erro de banco sobe como exceção: quem chama responde 5xx e o
// celular entende como "sem confirmação agora", nunca como "deslogado".
export async function readSession(request:Request):Promise<SessionLookup> {
  const token=readCookie(request,SESSION_COOKIE);
  if(!token)return {user:null,token:null,ended:null};
  const db=await getDb();
  const hash=await tokenHash(token);
  const userColumns={
    id:users.id,name:users.name,username:users.username,email:users.email,profile:users.role,taskRoleId:users.taskRoleId,status:users.status,
    theme:users.theme,isPrimaryAdmin:users.isPrimaryAdmin,lastAccessAt:users.lastAccessAt,createdAt:users.createdAt,
    serviceFrontId:users.serviceFrontId,serviceFrontName:serviceFronts.name,
    allServiceFronts:users.allServiceFronts,canExport:users.canExport,jobTitle:users.jobTitle,
  };
  let found;
  let legacy=false;
  try{
    found=(await db.select({
      sessionId:userSessions.id,sessionKind:userSessions.kind,expiresAt:userSessions.expiresAt,lastSeenAt:userSessions.lastSeenAt,revokedAt:userSessions.revokedAt,revokeReason:userSessions.revokeReason,...userColumns,
    }).from(userSessions).innerJoin(users,eq(userSessions.userId,users.id)).leftJoin(serviceFronts,eq(users.serviceFrontId,serviceFronts.id)).where(eq(userSessions.tokenHash,hash)).limit(1))[0];
  }catch(error){
    if(!missingColumn(error))throw error;
    legacy=true;
    const old=(await db.select({sessionId:userSessions.id,expiresAt:userSessions.expiresAt,lastSeenAt:userSessions.lastSeenAt,...userColumns})
      .from(userSessions).innerJoin(users,eq(userSessions.userId,users.id)).leftJoin(serviceFronts,eq(users.serviceFrontId,serviceFronts.id)).where(eq(userSessions.tokenHash,hash)).limit(1))[0];
    found=old?{...old,sessionKind:null,revokedAt:null,revokeReason:null}:undefined;
  }
  const now=new Date();
  const ended=sessionEndReason(found?{revokedAt:found.revokedAt,revokeReason:found.revokeReason,expiresAt:found.expiresAt,userActive:found.status==="ACTIVE"&&Boolean(found.username)}:null,now);
  if(ended){
    if(!legacy)await logSessionEnd(db,request,ended,found?{id:found.sessionId,userId:found.id,kind:found.sessionKind,expiresAt:found.expiresAt,revokedAt:found.revokedAt}:null,hash);
    return {user:null,token,ended};
  }
  const {sessionId,sessionKind,expiresAt,lastSeenAt,revokedAt:_revokedAt,revokeReason:_revokeReason,...row}=found!;
  void _revokedAt; void _revokeReason;
  const renewal=legacy?null:slidingRenewal({kind:isSessionKind(sessionKind)?sessionKind:null,lastSeenAt,expiresAt},row.profile,now);
  if(renewal){
    try{await db.update(userSessions).set({kind:renewal.kind,expiresAt:renewal.expiresAt,lastSeenAt:now.toISOString()}).where(eq(userSessions.id,sessionId));}
    catch(error){console.error("[auth.session] Falha ao renovar a validade",error);}
  }
  const serviceFrontIds=row.allServiceFronts||row.profile==="ADMIN"?[]:await userServiceFrontIds(row.id);
  return {user:{...row,username:row.username!,permissions:await effectivePermissions(row.id,row.profile),serviceFrontIds},token,ended:null};
}

export async function getSessionUser(request:Request):Promise<SessionUser|null> {
  return (await readSession(request)).user;
}

// permission: uma permissão ou uma lista (basta ter uma delas).
export async function authorize(request:Request,permission?:Permission|readonly Permission[]) {
  const session=await readSession(request);
  const user=session.user;
  // Sessão que não vale mais: apaga o cookie junto com o 401 (o próximo pedido nem leva o cookie).
  if(!user)return {user:null,response:Response.json({error:"Sessão não autenticada."},{status:401,headers:session.token?{"Set-Cookie":clearSessionCookie()}:undefined})};
  if(user.profile==="CAMPO"){
    const pathname=new URL(request.url).pathname;
    if(!FIELD_ALLOWED_API.some((prefix)=>pathname===prefix||pathname.startsWith(prefix.endsWith("/")?prefix:`${prefix}/`)))
      return {user:null,response:Response.json({error:"Acesso de campo permite apenas o Controle Diário."},{status:403})};
  }
  const required=permission===undefined?[]:typeof permission==="string"?[permission]:permission;
  if(required.length&&!required.some((item)=>user.permissions.includes(item)))return {user:null,response:Response.json({error:"Você não possui permissão para esta ação."},{status:403})};
  return {user,response:null};
}

export async function audit(actorId:number|null,affectedUserId:number,action:string,previousValue?:unknown,newValue?:unknown) {
  const db=await getDb();
  await db.insert(auditLogs).values({
    userId:actorId,entityType:"USER",entityId:String(affectedUserId),action,
    previousValue:previousValue===undefined?null:JSON.stringify(previousValue),
    newValue:newValue===undefined?null:JSON.stringify(newValue),
  });
}

export async function ensurePrimaryAdmin() {
  const db=await getDb();
  const completed=(await db.select({key:authBootstrap.key}).from(authBootstrap).where(eq(authBootstrap.key,INITIAL_ADMIN_BOOTSTRAP_KEY)).limit(1))[0];
  if(completed)return;
  const initialPassword=typeof process.env.INITIAL_ADMIN_PASSWORD==="string"?process.env.INITIAL_ADMIN_PASSWORD:"";
  if(!initialPassword)throw new Error("A credencial inicial do administrador não está configurada no servidor.");

  const salt=newSalt();
  const now=new Date().toISOString();
  const hash=await passwordHash(initialPassword,salt);
  let existing=(await db.select({id:users.id}).from(users).where(eq(users.username,INITIAL_ADMIN_USERNAME)).limit(1))[0];
  if(!existing)existing=(await db.select({id:users.id}).from(users).where(eq(users.email,INITIAL_ADMIN_EMAIL)).limit(1))[0];
  // Cargo raiz do Gestor de Cargos de Tarefas — normalmente já existe (seed da migration), mas
  // resolvido por nome em vez de ID fixo para não quebrar se o ADMIN renomear o cargo raiz.
  const rootRole=(await db.select({id:taskRoles.id}).from(taskRoles).where(eq(taskRoles.isRoot,true)).limit(1))[0];

  let adminId:number;
  if(existing){
    adminId=existing.id;
    await db.update(users).set({
      name:"Mathews",username:INITIAL_ADMIN_USERNAME,passwordHash:hash,passwordSalt:salt,
      role:"ADMIN",hierarchyLevel:"ADMIN",taskRoleId:rootRole?.id??null,status:"ACTIVE",isPrimaryAdmin:true,passwordUpdatedAt:now,updatedAt:now,
    }).where(eq(users.id,adminId));
    await revokeUserSessions(db,adminId,"SENHA_TROCADA");
  }else{
    const inserted=await db.insert(users).values({
      email:INITIAL_ADMIN_EMAIL,name:"Mathews",username:INITIAL_ADMIN_USERNAME,
      passwordHash:hash,passwordSalt:salt,role:"ADMIN",hierarchyLevel:"ADMIN",taskRoleId:rootRole?.id??null,status:"ACTIVE",
      theme:"LIGHT",isPrimaryAdmin:true,passwordUpdatedAt:now,updatedAt:now,
    }).returning({id:users.id});
    adminId=inserted[0].id;
  }

  await db.insert(authBootstrap).values({key:INITIAL_ADMIN_BOOTSTRAP_KEY,completedAt:now}).onConflictDoNothing();
  console.info("[auth.bootstrap] Administrador principal verificado",{userId:adminId});
}

export function publicUser(user:SessionUser) {
  return user;
}

export function profileLabel(profile:Profile) {
  return profile==="CAMPO"?"Operador (campo)":profile==="ADMIN"?"Administrador":profile==="GESTOR"?"Gestor":profile==="OFICINA"?"Manutenção / Oficina":profile==="OPERADOR"?"Operador":"Operador";
}
