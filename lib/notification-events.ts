import { frentesVisiveis } from "./access";
import type { Permission, Profile, SessionUser } from "./auth";

// ---------------------------------------------------------------------------
// Catálogo dos eventos que viram notificação (sino + celular) e as regras de quem recebe. Sem banco:
// usado pelo servidor (lib/notifications.ts) e pela tela "Configurar notificações".
//
// DIRETO = vai para a pessoa envolvida (o motorista do abastecimento, quem pediu a mudança de frente,
// o responsável pela tarefa). GRUPO = vai para quem cuida daquilo na frente do evento: por padrão quem
// tem a permissão do evento e enxerga a frente; o ADMIN pode somar perfis e pessoas, ou desligar a regra
// da permissão e escolher só as pessoas.
// ---------------------------------------------------------------------------
export type NotificationLink = { secao: string; aba?: string };
export type EventKey =
  | "convoy.pending" | "convoy.approved" | "convoy.rejected" | "convoy.correction"
  | "front_change.requested" | "front_change.answered"
  | "task.assigned" | "task.completed" | "task.due_soon" | "task.updated"
  | "pendencia.new" | "oil.overdue" | "stock.low" | "fuel.outlier"
  | "manual";
export type EventDef = {
  key: EventKey;
  area: string;
  label: string;
  description: string;
  audience: "DIRETO" | "GRUPO" | "AVULSO";
  // GRUPO: quem tem esta permissão (e enxerga a frente) recebe, se a regra estiver ligada.
  permission?: Permission;
  permissionLabel?: string;
  // GRUPO sem permissão própria: perfis que recebem por padrão (o ADMIN muda na tela).
  defaultProfiles?: Profile[];
  // Aparece no sino mas a pessoa não pode silenciar (avisos do administrador).
  locked?: boolean;
  // Verificado uma vez por dia (lib/notification-daily.ts), não na hora da ação.
  daily?: boolean;
};

export const EVENTS: readonly EventDef[] = [
  { key: "convoy.pending", area: "Combustível", label: "Abastecimento do comboio aguardando aprovação", description: "Para quem aprova, agrupado por frente: \"5 abastecimentos aguardando aprovação\". Abre Combustível → Aprovação → Aprovar.", audience: "GRUPO", permission: "fuel.convoy_approve", permissionLabel: "quem aprova abastecimentos do comboio" },
  { key: "convoy.approved", area: "Combustível", label: "Abastecimento aprovado", description: "Para o motorista do comboio.", audience: "DIRETO" },
  { key: "convoy.rejected", area: "Combustível", label: "Abastecimento rejeitado", description: "Para o motorista do comboio, com o motivo.", audience: "DIRETO" },
  { key: "convoy.correction", area: "Combustível", label: "Correção pedida no abastecimento", description: "Para o motorista do comboio, com o que precisa corrigir.", audience: "DIRETO" },
  { key: "fuel.outlier", area: "Combustível", label: "Consumo fora da média", description: "Uma vez por dia: equipamentos com consumo (L/h ou km/L) dos últimos 30 dias mais de 25% fora da média do tipo, só os que entraram na lista desde o último aviso.", audience: "GRUPO", defaultProfiles: ["ADMIN", "GESTOR"], daily: true },
  { key: "front_change.requested", area: "Controle Diário", label: "Pedido de mudança de frente", description: "Para quem aprova as solicitações de mudança de frente (frente atual ou pedida).", audience: "GRUPO", permission: "daily.front_requests", permissionLabel: "quem aprova mudança de frente" },
  { key: "front_change.answered", area: "Controle Diário", label: "Resposta da mudança de frente", description: "Para quem pediu: aprovada ou recusada, com a observação.", audience: "DIRETO" },
  { key: "pendencia.new", area: "Manutenção", label: "Pendência nova", description: "Checklist com pendência ou bloqueado e problema informado no Controle Diário.", audience: "GRUPO", defaultProfiles: ["ADMIN", "GESTOR", "OFICINA"] },
  { key: "oil.overdue", area: "Manutenção", label: "Troca de óleo vencida", description: "Uma vez por dia, por frente, só com as trocas que venceram desde o último aviso.", audience: "GRUPO", defaultProfiles: ["ADMIN", "GESTOR", "OFICINA"], daily: true },
  { key: "stock.low", area: "Estoque", label: "Estoque baixo", description: "Uma vez por dia, por frente: produto com saldo menor que 1 mês do consumo médio (últimos 90 dias) — a mesma regra do Assistente JC, já que não há estoque mínimo cadastrado. Só os que ficaram baixos desde o último aviso.", audience: "GRUPO", defaultProfiles: ["ADMIN", "GESTOR", "ALMOXARIFADO"], daily: true },
  { key: "task.assigned", area: "Tarefas", label: "Tarefa recebida", description: "Para quem recebeu (ou passou a ser responsável por) uma tarefa.", audience: "DIRETO" },
  { key: "task.completed", area: "Tarefas", label: "Tarefa concluída", description: "Para quem enviou: o responsável pediu a conclusão ou ela foi aprovada.", audience: "DIRETO" },
  { key: "task.due_soon", area: "Tarefas", label: "Tarefa vencendo", description: "Uma vez por dia: tarefas abertas que vencem hoje ou amanhã, para o responsável.", audience: "DIRETO", daily: true },
  { key: "task.updated", area: "Tarefas", label: "Outras mudanças na tarefa", description: "Conclusão recusada, pedido de não realização e resposta, cancelamento.", audience: "DIRETO" },
  { key: "manual", area: "Avisos", label: "Aviso do administrador", description: "Notificação avulsa enviada em Notificações → Enviar.", audience: "AVULSO", locked: true },
];

export const eventDef = (key: string) => EVENTS.find((item) => item.key === key) ?? null;
export const isEventKey = (key: string): key is EventKey => EVENTS.some((item) => item.key === key);

// Configuração do ADMIN para um evento (sem linha no banco = este padrão).
export type EventSetting = { event: EventKey; enabled: boolean; push: boolean; includePermission: boolean; profiles: Profile[]; userIds: number[]; onlyFront: boolean };
export const defaultSetting = (event: EventKey): EventSetting => ({ event, enabled: true, push: true, includePermission: true, profiles: [...(eventDef(event)?.defaultProfiles ?? [])], userIds: [], onlyFront: true });

export const PROFILES: readonly Profile[] = ["ADMIN", "GESTOR", "OFICINA", "OPERADOR", "ALMOXARIFADO", "CAMPO"];
export function parseSetting(event: EventKey, row: { enabled: boolean; push: boolean; includePermission: boolean; profiles: string; userIds: string; onlyFront: boolean } | null | undefined): EventSetting {
  if (!row) return defaultSetting(event);
  const list = (value: string) => { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
  return {
    event, enabled: row.enabled, push: row.push, includePermission: row.includePermission, onlyFront: row.onlyFront,
    profiles: list(row.profiles).filter((item): item is Profile => PROFILES.includes(item as Profile)),
    userIds: list(row.userIds).map(Number).filter((id) => Number.isInteger(id) && id > 0),
  };
}

// Quem pode receber: usuário ativo com o necessário para decidir permissão e frente.
export type Candidate = Pick<SessionUser, "id" | "profile" | "allServiceFronts" | "serviceFrontIds" | "permissions"> & { active: boolean };
const seesFront = (user: Candidate, frontId: number) => {
  const fronts = frentesVisiveis(user);
  return fronts === "ALL" || fronts.includes(frontId);
};

// Destinatários de um evento de GRUPO nas frentes do evento (basta enxergar uma; lista vazia = evento
// sem frente). O funcionário de campo (CAMPO) só entra se for escolhido pelo nome.
export function groupRecipients(candidates: readonly Candidate[], setting: EventSetting, def: EventDef, frontIds: readonly number[]) {
  return candidates.filter((user) => {
    if (!user.active) return false;
    const chosen = setting.userIds.includes(user.id);
    if (!chosen && user.profile === "CAMPO") return false;
    const byPermission = setting.includePermission && Boolean(def.permission) && user.permissions.includes(def.permission!);
    if (!chosen && !byPermission && !setting.profiles.includes(user.profile)) return false;
    return !setting.onlyFront || !frontIds.length || frontIds.some((frontId) => seesFront(user, frontId));
  }).map((user) => user.id);
}

// Envio avulso: todos, perfis e/ou pessoas; frentes escolhidas = só quem enxerga alguma delas.
export type ManualTarget = { all: boolean; profiles: Profile[]; userIds: number[]; frontIds: number[] };
export function manualRecipients(candidates: readonly Candidate[], target: ManualTarget) {
  return candidates.filter((user) => {
    if (!user.active) return false;
    if (!target.all && !target.profiles.includes(user.profile) && !target.userIds.includes(user.id)) return false;
    return !target.frontIds.length || target.userIds.includes(user.id) || target.frontIds.some((frontId) => seesFront(user, frontId));
  }).map((user) => user.id);
}

// Texto curto para o celular (o aviso corta textos longos de qualquer jeito).
export const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
