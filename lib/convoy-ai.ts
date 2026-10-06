import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, convoyFuelRecords, equipment } from "../db/schema";
import { assistantConfig } from "./assistant-config";
import { aiReadingDiverges } from "./convoy-rules";
import { readConvoyPhotoBytes } from "./convoy-storage";
import { convoySettings } from "./convoy";

// ---------------------------------------------------------------------------
// Conferência automática da foto do KM/horímetro (opcional: Combustível → Aprovação do comboio →
// Configuração). Usa a mesma chave/modelo do Assistente JC (ANTHROPIC_API_KEY, ASSISTANT_MODEL):
// lê o número do painel e compara com o digitado. Divergiu = etiqueta "Foto diverge" na aprovação,
// com o número lido. NUNCA aprova sozinho e nunca muda os valores do registro.
// ---------------------------------------------------------------------------
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["legivel", "leitura", "observacao"],
  properties: {
    legivel: { type: "boolean", description: "true se o número do hodômetro/horímetro está legível na foto." },
    leitura: { type: "number", description: "Número mostrado no painel (sem pontos de milhar; decimal com ponto). 0 se ilegível." },
    observacao: { type: "string", description: "Curta: o que atrapalhou a leitura, se houve." },
  },
} as const;

export type ConvoyAiResult = { status: "CONFERE" | "DIVERGE" | "ILEGIVEL" | "ERRO"; reading: number | null };

export async function checkConvoyPhoto(recordId: number, options: { force?: boolean; actorId?: number | null } = {}): Promise<ConvoyAiResult | null> {
  const db = await getDb();
  const config = assistantConfig();
  if (!config.configured) return null;
  if (!options.force && !(await convoySettings(db)).aiPhotoCheck) return null;
  const record = (await db.select({ id: convoyFuelRecords.id, meterPhotoKey: convoyFuelRecords.meterPhotoKey, reading: convoyFuelRecords.reading, unit: convoyFuelRecords.readingUnit, prefix: equipment.prefix })
    .from(convoyFuelRecords).innerJoin(equipment, eq(equipment.id, convoyFuelRecords.equipmentId)).where(eq(convoyFuelRecords.id, recordId)).limit(1))[0];
  if (!record?.meterPhotoKey || record.reading === null) return null;
  const photo = await readConvoyPhotoBytes(record.meterPhotoKey);
  if (!photo) return null;
  let result: ConvoyAiResult;
  try {
    const api = new Anthropic({ timeout: config.timeoutMs, maxRetries: 1 });
    const response = await api.messages.create({
      model: config.model, max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
      system: "Você lê fotos do painel de equipamentos florestais (caminhões e máquinas) para conferir a leitura digitada pelo motorista do comboio. Leia só o número do hodômetro (KM) ou do horímetro (horas). Ignore a data, hora e localização impressas no canto da foto. Não invente: se não der para ler com segurança, legivel=false.",
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: photo.contentType as "image/jpeg" | "image/png" | "image/webp", data: photo.buffer.toString("base64") } },
        { type: "text", text: `Equipamento ${record.prefix}. Leia o ${record.unit === "KM" ? "hodômetro (KM)" : "horímetro (horas)"} desta foto.` },
      ] }],
    });
    if (response.stop_reason === "refusal") result = { status: "ERRO", reading: null };
    else {
      const text = response.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("");
      const parsed = JSON.parse(text) as { legivel?: boolean; leitura?: number };
      const read = typeof parsed.leitura === "number" && Number.isFinite(parsed.leitura) ? parsed.leitura : null;
      result = !parsed.legivel || read === null ? { status: "ILEGIVEL", reading: null } : { status: aiReadingDiverges(record.reading, read) ? "DIVERGE" : "CONFERE", reading: read };
    }
  } catch (error) {
    console.error("[convoy.ai]", error instanceof Error ? error.message : error);
    result = { status: "ERRO", reading: null };
  }
  const now = new Date().toISOString();
  await db.update(convoyFuelRecords).set({ aiStatus: result.status, aiReading: result.reading, aiCheckedAt: now, updatedAt: now }).where(eq(convoyFuelRecords.id, recordId));
  await db.insert(auditLogs).values({ userId: options.actorId ?? null, entityType: "CONVOY_FUEL", entityId: String(recordId), action: "FOTO CONFERIDA PELO ASSISTENTE", newValue: JSON.stringify({ ...result, typed: record.reading }), occurredAt: now });
  return result;
}
