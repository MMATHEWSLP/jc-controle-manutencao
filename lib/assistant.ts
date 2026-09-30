import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { assistantLogs, fuelTypes } from "../db/schema";
import { assistantConfig, type FichaMediaType } from "./assistant-config";
import { FICHA_OUTPUT_SCHEMA, normalizeFicha, type FichaExtraction, type FichaRow } from "./assistant-rules";
import { ASSISTANT_TOOLS, brDate, loadEquipmentIndex, matchEquipment, runAssistantTool, type AssistantToolContext } from "./assistant-tools";
import type { SessionUser } from "./auth";
import { fuelLocalDay, fuelVisibleFronts } from "./fuel";
import { importKey } from "./fuel-import-rules";

// ---------------------------------------------------------------------------
// Assistente JC: chat de consulta (ferramentas só de leitura) e leitor de fichas de abastecimento.
// A chave da API fica só no servidor (ANTHROPIC_API_KEY). Cada pergunta/ficha vira uma linha em
// assistant_logs (pergunta, ferramentas, resposta, tokens), que também conta o limite diário.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type ToolCall = { name: string; input: unknown; ok: boolean };

export class AssistantError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const MAX_CHAT_STEPS = 6;
const MAX_FICHA_STEPS = 6;
const FICHA_MAX_TOKENS = 16000;

// Início do dia de hoje (America/Fortaleza, UTC−3, sem horário de verão) em ISO UTC.
const todayStartIso = () => `${fuelLocalDay()}T03:00:00.000Z`;

export async function assistantUsageToday(db: Db, userId: number) {
  const [row] = await db.select({
    messages: sql<number>`count(*) FILTER (WHERE ${assistantLogs.kind} = 'CHAT')::int`,
    photos: sql<number>`coalesce(sum(${assistantLogs.imageCount}) FILTER (WHERE ${assistantLogs.kind} = 'FICHA'), 0)::int`,
  }).from(assistantLogs).where(and(eq(assistantLogs.userId, userId), gte(assistantLogs.createdAt, todayStartIso()), inArray(assistantLogs.status, ["OK", "RECUSADO"])));
  const config = assistantConfig();
  const messages = Number(row?.messages ?? 0), photos = Number(row?.photos ?? 0);
  return { messages, photos, messagesLeft: Math.max(0, config.dailyMessages - messages), photosLeft: Math.max(0, config.dailyPhotos - photos), dailyMessages: config.dailyMessages, dailyPhotos: config.dailyPhotos };
}

async function writeLog(db: Db, entry: typeof assistantLogs.$inferInsert) {
  try { await db.insert(assistantLogs).values({ ...entry, question: entry.question?.slice(0, 4000) ?? "", answer: entry.answer?.slice(0, 30000) ?? null, error: entry.error?.slice(0, 1000) ?? null }); }
  catch (error) { console.error("[assistente.log]", error); }
}

function client() {
  const config = assistantConfig();
  if (!config.configured) throw new AssistantError("O Assistente JC ainda não foi configurado (falta a chave da API no servidor). Avise o administrador.", 503);
  return new Anthropic({ timeout: config.timeoutMs, maxRetries: 1 });
}

// Mensagem amigável para falhas da API (nunca repassa detalhes técnicos ao usuário).
export function friendlyApiError(error: unknown) {
  if (error instanceof AssistantError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new AssistantError("A consulta demorou demais e foi interrompida. Tente de novo ou faça uma pergunta mais específica.", 504);
  if (error instanceof Anthropic.RateLimitError) return new AssistantError("O assistente está recebendo muitas perguntas agora. Aguarde um minuto e tente de novo.", 429);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return new AssistantError("A chave da API do assistente é inválida ou está sem permissão. Avise o administrador.", 503);
  if (error instanceof Anthropic.BadRequestError) return new AssistantError("O assistente não conseguiu processar este pedido (conteúdo ou imagem inválida). Tente de novo com outra pergunta ou outra foto.", 400);
  if (error instanceof Anthropic.APIConnectionError) return new AssistantError("Sem conexão com o serviço do assistente agora. Tente de novo em instantes.", 503);
  if (error instanceof Anthropic.APIError) return new AssistantError("O serviço do assistente está instável agora. Tente de novo em instantes.", 503);
  return new AssistantError("Não foi possível responder agora. Tente de novo em instantes.", 500);
}

const textOf = (content: Anthropic.ContentBlock[]) => content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("\n").trim();

// Roda o laço de ferramentas até o modelo terminar (ou o limite de passos/tempo).
async function runLoop(api: Anthropic, params: Omit<Anthropic.MessageCreateParamsNonStreaming, "messages">, messages: Anthropic.MessageParam[], ctx: AssistantToolContext, limits: { maxSteps: number; deadline: number; requestTimeout: number }, tools: ToolCall[], usage: { input: number; output: number }) {
  for (let step = 0; step < limits.maxSteps; step++) {
    if (Date.now() > limits.deadline) throw new AssistantError("A consulta demorou demais e foi interrompida. Tente uma pergunta mais específica.", 504);
    const response = await api.messages.create({ ...params, messages }, { timeout: limits.requestTimeout });
    usage.input += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    usage.output += response.usage.output_tokens;
    if (response.stop_reason === "refusal") return { refused: true, response };
    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) return { refused: false, response };
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const result = await runAssistantTool(ctx, use.name, use.input);
      tools.push({ name: use.name, input: use.input, ok: result.ok });
      results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, ...(result.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new AssistantError("Não consegui concluir a consulta com poucas etapas. Tente uma pergunta mais específica.", 422);
}

async function frontsLine(ctx: AssistantToolContext) {
  const visible = await fuelVisibleFronts(ctx.db, ctx.user);
  const displayed = ctx.displayed === "ALL" ? visible : visible.filter((front) => (ctx.displayed as number[]).includes(front.id));
  return { visible: visible.map((front) => front.name), displayed: (displayed.length ? displayed : visible).map((front) => front.name) };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
export type ChatTurn = { role: "user" | "assistant"; text: string };

export function readHistory(input: unknown): ChatTurn[] {
  if (!Array.isArray(input)) return [];
  const turns = input.slice(-10).flatMap((item) => {
    const turn = item as { role?: unknown; text?: unknown };
    const text = typeof turn?.text === "string" ? turn.text.trim().slice(0, 2000) : "";
    return (turn?.role === "user" || turn?.role === "assistant") && text ? [{ role: turn.role, text } as ChatTurn] : [];
  });
  // A conversa precisa começar pelo usuário e alternar os papéis.
  const result: ChatTurn[] = [];
  for (const turn of turns) {
    if (result.length === 0 && turn.role !== "user") continue;
    if (result.length && result[result.length - 1].role === turn.role) result[result.length - 1] = { role: turn.role, text: `${result[result.length - 1].text}\n${turn.text}` };
    else result.push(turn);
  }
  if (result.length && result[result.length - 1].role === "user") result.pop();
  return result;
}

function chatSystemPrompt(user: SessionUser, fronts: { visible: string[]; displayed: string[] }) {
  return `Você é o Assistente JC, do sistema de manutenção preventiva, frota e combustível da JC Serviços Florestais.
Hoje é ${brDate(fuelLocalDay())} (horário de Fortaleza). Quem pergunta: ${user.name} (perfil ${user.profile}).
Frentes em exibição na tela dele: ${fronts.displayed.join(", ") || "nenhuma"}. Frentes que ele pode consultar: ${fronts.visible.join(", ") || "nenhuma"}.

Como responder:
- Sempre em português do Brasil, curto e direto: poucas linhas ou uma lista curta com "- ". Sem tabelas.
- Use só os dados devolvidos pelas ferramentas. Toda resposta com números diz o período e a(s) frente(s) considerados.
- Números no formato brasileiro (1.234,50), datas DD/MM/AAAA, unidades L, km, h, km/L, L/h. As ferramentas já devolvem nesse formato: repita sem converter.
- Sem frente na pergunta, as ferramentas usam as frentes em exibição; sem período, o mês corrente até hoje. Deixe isso claro na resposta.
- Se nenhuma ferramenta responde à pergunta, diga que não consegue responder isso pelo assistente e indique a tela do sistema onde procurar. Nunca invente, estime ou complete dados.
- Você só consulta: não registra, altera nem apaga nada. Se pedirem um lançamento ou alteração, explique que deve ser feito na tela correspondente.
- Se o equipamento citado for ambíguo, use buscar_equipamento e, se continuar ambíguo, pergunte qual é.
- Se uma ferramenta devolver erro (sem acesso, não encontrado), explique isso ao usuário em uma frase.`;
}

export async function runAssistantChat(ctx: AssistantToolContext, question: string, history: ChatTurn[]) {
  const config = assistantConfig();
  const api = client();
  const usage = await assistantUsageToday(ctx.db, ctx.user.id);
  if (usage.messagesLeft <= 0) throw new AssistantError(`Você atingiu o limite de ${config.dailyMessages} perguntas por dia no assistente. O limite renova amanhã.`, 429);
  const started = Date.now();
  const tools: ToolCall[] = [];
  const tokens = { input: 0, output: 0 };
  const messages: Anthropic.MessageParam[] = [...history.map((turn) => ({ role: turn.role, content: turn.text })), { role: "user", content: question }];
  try {
    const { refused, response } = await runLoop(api, {
      model: config.model, max_tokens: config.maxTokens, system: chatSystemPrompt(ctx.user, await frontsLine(ctx)), tools: ASSISTANT_TOOLS,
      output_config: { effort: "medium" },
    }, messages, ctx, { maxSteps: MAX_CHAT_STEPS, deadline: started + config.timeoutMs * 2, requestTimeout: config.timeoutMs }, tools, tokens);
    let answer = refused ? "Não posso ajudar com esse pedido. Pergunte sobre combustível, consumo, saldos, trocas de óleo ou histórico de manutenção." : textOf(response.content);
    if (!refused && response.stop_reason === "max_tokens") answer = answer ? `${answer}\n\n(Resposta cortada por ser longa: refine a pergunta.)` : "A resposta ficou longa demais. Refine a pergunta (um período, frente ou equipamento).";
    if (!answer) answer = "Não consegui montar uma resposta. Tente perguntar de outro jeito.";
    await writeLog(ctx.db, { userId: ctx.user.id, kind: "CHAT", question, tools: JSON.stringify(tools), answer, status: refused ? "RECUSADO" : "OK", model: config.model, inputTokens: tokens.input, outputTokens: tokens.output, durationMs: Date.now() - started });
    return { answer, tools: tools.map((tool) => tool.name), remaining: Math.max(0, usage.messagesLeft - 1) };
  } catch (error) {
    const friendly = friendlyApiError(error);
    if (!(error instanceof AssistantError)) console.error("[assistente.chat]", error);
    await writeLog(ctx.db, { userId: ctx.user.id, kind: "CHAT", question, tools: JSON.stringify(tools), status: "ERRO", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), model: config.model, inputTokens: tokens.input, outputTokens: tokens.output, durationMs: Date.now() - started });
    throw friendly;
  }
}

// ---------------------------------------------------------------------------
// Leitor de fichas de abastecimento (fotos → linhas no formato do modelo de importação)
// ---------------------------------------------------------------------------
export type FichaImage = { name: string; mediaType: FichaMediaType; data: string; bytes: number };

function fichaSystemPrompt(fronts: string[], fuels: string[]) {
  return `Você lê fotos de fichas de abastecimento de combustível da JC Serviços Florestais e transcreve cada linha no formato do modelo de importação do sistema.
Frentes cadastradas: ${fronts.join(", ") || "—"}. Combustíveis cadastrados: ${fuels.join(", ") || "—"}.

Colunas de cada linha: data, tipo, frente, origem, combustivel, equipamento, empresa, litros, leitura, tanque_cheio, motorista, observacao.

Regras (siga todas):
1. A data do cabeçalho vale para todas as linhas, no formato DD/MM/AAAA. Ignore o horário.
2. Frente e combustível vêm do cabeçalho ou das colunas impressas da ficha; use o nome cadastrado mais próximo. Origem = "Frente <frente>" (ou "Porto <frente>" se a ficha indicar o porto).
3. Para cada equipamento, chame buscar_equipamento com o código OU a placa escrita na ficha (pode chamar várias vezes na mesma resposta) e preencha a coluna equipamento com o CÓDIGO CADASTRADO devolvido (ex.: "CM-35"). Se só achar pela placa, use o código cadastrado e registre a dúvida "equipamento não encontrado pelo código, encontrado pela placa <placa>". Se não achar, mantenha o que está escrito e registre a dúvida "equipamento não encontrado no cadastro".
4. Empresa "JC" ou vazia = tipo SAIDA_FROTA e empresa vazia. Empresa de fora = SAIDA_TERCEIRO (ou SAIDA_PRESTADOR se a ficha disser prestador), com a placa do veículo em equipamento.
5. Leitura "0000", riscada ou em branco = deixe vazio. Leitura sem pontos nem vírgulas (ex.: 411208).
6. Litros como escritos (ex.: 297 ou 297,5). tanque_cheio = SIM, a menos que a ficha indique parcial (NAO).
7. Nome do motorista com iniciais maiúsculas (ex.: "José Sousa").
8. Observação padrão: "Ficha de abastecimento DD/MM/AAAA" (a data do cabeçalho). Só use outra observação se a ficha tiver uma anotação escrita na linha. Nunca escreva observações sobre quantidade de diesel.
9. Não "corrija" números por conta própria: se um dígito estiver ilegível, use a leitura mais provável e registre em duvidas a coluna e o motivo (ex.: "primeiro dígito ilegível", "pode ser 3 ou 8"). Registre também qualquer outra incerteza (nome ilegível, linha rasurada).
10. Uma linha por abastecimento, na ordem da ficha, juntando todas as fotos. Ignore linhas totalmente em branco, totais e assinaturas.
11. Em avisos, coloque observações gerais (ex.: "foto 2 cortada na parte de baixo"). Se a imagem não for uma ficha de abastecimento, devolva linhas vazias e explique em avisos.
Responda somente com o JSON do formato pedido.`;
}

export async function readFuelSheet(ctx: AssistantToolContext, images: FichaImage[], note: string) {
  const config = assistantConfig();
  const api = client();
  const usage = await assistantUsageToday(ctx.db, ctx.user.id);
  if (usage.photosLeft < images.length) throw new AssistantError(usage.photosLeft <= 0 ? `Você atingiu o limite de ${config.dailyPhotos} fotos de ficha por dia. O limite renova amanhã.` : `Restam ${usage.photosLeft} foto(s) hoje; envie no máximo ${usage.photosLeft}.`, 429);
  const started = Date.now();
  const tools: ToolCall[] = [];
  const tokens = { input: 0, output: 0 };
  const fronts = await frontsLine(ctx);
  const fuels = (await ctx.db.select({ name: fuelTypes.name }).from(fuelTypes).where(eq(fuelTypes.active, true)).orderBy(asc(fuelTypes.sortOrder), asc(fuelTypes.name))).map((row) => row.name);
  const question = `Ficha: ${images.length} foto(s)${note ? ` — ${note}` : ""}`;
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: [
      ...images.flatMap((image, index): Anthropic.ContentBlockParam[] => [
        { type: "text", text: `Foto ${index + 1} (${image.name}):` },
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
      ]),
      { type: "text", text: `Transcreva a ficha de abastecimento destas fotos seguindo as regras.${note ? ` Observação de quem enviou: ${note}` : ""}` },
    ],
  }];
  try {
    const { refused, response } = await runLoop(api, {
      model: config.model, max_tokens: FICHA_MAX_TOKENS, system: fichaSystemPrompt(fronts.visible, fuels),
      tools: ASSISTANT_TOOLS.filter((tool) => tool.name === "buscar_equipamento"),
      output_config: { effort: "medium", format: { type: "json_schema", schema: FICHA_OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
    }, messages, ctx, { maxSteps: MAX_FICHA_STEPS, deadline: started + config.timeoutMs * 4, requestTimeout: config.timeoutMs * 2 }, tools, tokens);
    if (refused) throw new AssistantError("O assistente não conseguiu ler estas fotos. Envie fotos nítidas da ficha de abastecimento.", 422);
    if (response.stop_reason === "max_tokens") throw new AssistantError("A ficha é longa demais para uma leitura só. Envie menos fotos por vez.", 422);
    let extraction: FichaExtraction;
    try { extraction = JSON.parse(textOf(response.content)) as FichaExtraction; }
    catch { throw new AssistantError("Não consegui transcrever a ficha. Tente de novo com fotos mais nítidas.", 422); }
    const result = await checkFichaEquipment(ctx, normalizeFicha(extraction));
    await writeLog(ctx.db, {
      userId: ctx.user.id, kind: "FICHA", question, imageCount: images.length, imageNames: images.map((image) => `${image.name} (${Math.round(image.bytes / 1024)} KB)`).join(", "),
      tools: JSON.stringify(tools), answer: JSON.stringify(result), status: "OK", model: config.model, inputTokens: tokens.input, outputTokens: tokens.output, durationMs: Date.now() - started,
    });
    return { ...result, remainingPhotos: Math.max(0, usage.photosLeft - images.length) };
  } catch (error) {
    const friendly = friendlyApiError(error);
    if (!(error instanceof AssistantError)) console.error("[assistente.ficha]", error);
    await writeLog(ctx.db, {
      userId: ctx.user.id, kind: "FICHA", question, imageCount: images.length, imageNames: images.map((image) => image.name).join(", "), tools: JSON.stringify(tools), status: "ERRO",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), model: config.model, inputTokens: tokens.input, outputTokens: tokens.output, durationMs: Date.now() - started,
    });
    throw friendly;
  }
}

// Confere no cadastro cada equipamento extraído (independente do que o modelo disse): código
// cadastrado quando achar pela placa; dúvida quando não achar ou quando houver mais de um.
export async function checkFichaEquipment(ctx: AssistantToolContext, ficha: ReturnType<typeof normalizeFicha>) {
  const index = await loadEquipmentIndex(ctx);
  const rows: FichaRow[] = ficha.rows.map((row) => {
    const values = { ...row.values };
    const doubts = Object.fromEntries(Object.entries(row.doubts).map(([key, list]) => [key, [...(list ?? [])]])) as FichaRow["doubts"];
    const add = (reason: string) => { const list = (doubts.equipamento ??= []); if (!list.includes(reason)) list.push(reason); };
    const written = values.equipamento;
    if (!written) { add("equipamento em branco"); return { values, doubts }; }
    let found: ReturnType<typeof matchEquipment> | null = null;
    try { found = matchEquipment(index, written); } catch { found = null; }
    if (values.tipo === "SAIDA_FROTA") {
      const exact = found?.fleet.filter((item) => item.foundBy === "código" || item.foundBy === "placa") ?? [];
      if (exact.length === 1) {
        if (exact[0].foundBy === "placa" && importKey(exact[0].prefix) !== importKey(written)) add(`equipamento não encontrado pelo código, encontrado pela placa ${exact[0].plate}`);
        values.equipamento = exact[0].prefix;
      } else if (exact.length > 1) add(`"${written}" corresponde a mais de um equipamento (${exact.map((item) => item.prefix).join(", ")})`);
      else {
        const vehicle = found?.vehicles.find((item) => item.foundBy === "placa");
        add(vehicle ? `placa de veículo de terceiro (${vehicle.company}): confira tipo e empresa` : "equipamento não encontrado no cadastro");
      }
    } else if (!found?.vehicles.some((item) => item.foundBy === "placa")) add("placa não encontrada no cadastro de Terceiros");
    return { values, doubts };
  });
  return { header: ficha.header, rows, warnings: ficha.warnings };
}
