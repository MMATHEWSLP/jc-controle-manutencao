import { eq } from "drizzle-orm";
import { getD1, getDb } from "../../../db";
import { systemSettings } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";

const defaults = {
  alertaHorasVerde: 100,
  alertaHorasAmareloInicio: 51,
  alertaHorasAmareloFim: 100,
  alertaHorasLaranjaInicio: 1,
  alertaHorasLaranjaFim: 50,
  alertaKmVerde: 2000,
  alertaKmAmareloInicio: 1001,
  alertaKmAmareloFim: 2000,
  alertaKmLaranjaInicio: 1,
  alertaKmLaranjaFim: 1000,
  urgencyPercent: 20,
};

type SettingsInput = typeof defaults;

function json(data:unknown, status = 200) {
  return Response.json(data, { status });
}

function validate(input:unknown): SettingsInput | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const parsed = Object.fromEntries(
    Object.keys(defaults).map((key) => [key, Number(source[key])]),
  ) as SettingsInput;

  if (Object.values(parsed).some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (parsed.urgencyPercent < 1 || parsed.urgencyPercent > 100) return null;
  if (parsed.alertaHorasLaranjaInicio > parsed.alertaHorasLaranjaFim) return null;
  if (parsed.alertaHorasAmareloInicio > parsed.alertaHorasAmareloFim) return null;
  if (parsed.alertaKmLaranjaInicio > parsed.alertaKmLaranjaFim) return null;
  if (parsed.alertaKmAmareloInicio > parsed.alertaKmAmareloFim) return null;
  return parsed;
}

export async function GET(request:Request) {
  const auth=await authorize(request,"alerts.view");if(auth.response)return auth.response;
  const db = await getDb();
  const existing = await db.select().from(systemSettings).where(eq(systemSettings.id, 1)).limit(1);
  if (existing[0]) return json(existing[0]);
  const inserted = await db.insert(systemSettings).values({ id:1, ...defaults }).returning();
  return json(inserted[0]);
}

export async function PUT(request:Request) {
  if(!assertSameOrigin(request))return Response.json({ error:"Origem da solicitação não autorizada." }, { status:403 });
  const auth=await authorize(request,"alerts.settings");if(auth.response)return auth.response;
  const parsed = validate(await request.json().catch(() => null));
  if (!parsed) return json({ error:"Informe faixas válidas e não negativas." }, 400);

  const db = await getDb();
  const saved = await db.insert(systemSettings).values({ id:1, ...parsed }).onConflictDoUpdate({
    target:systemSettings.id,
    set:{ ...parsed, updatedAt:new Date().toISOString() },
  }).returning();
  await recalculateMaintenanceCycles(await getD1(),{force:true,notify:false});
  return json(saved[0]);
}
