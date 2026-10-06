import { and, asc, eq, ilike, inArray, isNull, ne, or } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { employees, equipment, serviceFronts } from "../../../../../db/schema";
import { frentesVisiveis } from "../../../../../lib/access";
import { authorize } from "../../../../../lib/auth";

// Busca para o aprovador corrigir o equipamento ou o motorista de um abastecimento do comboio
// (frentes que ele enxerga; equipamentos ativos e funcionários não demitidos).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ equipment: [], employees: [] });
  const fronts = frentesVisiveis(auth.user!);
  const like = `%${q}%`;
  const compact = q.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const db = await getDb();
  const [machines, people] = await Promise.all([
    db.select({ id: equipment.id, prefix: equipment.prefix, plate: equipment.plate, model: equipment.model, front: serviceFronts.name }).from(equipment).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId))
      .where(and(isNull(equipment.soldAt), ne(equipment.status, "INACTIVE"), fronts === "ALL" ? undefined : fronts.length ? inArray(equipment.serviceFrontId, fronts) : eq(equipment.id, -1),
        or(ilike(equipment.prefix, like), ilike(equipment.plate, like), ilike(equipment.code, like), compact ? ilike(equipment.sortKey, `%${compact}%`) : undefined))).orderBy(asc(equipment.sortKey)).limit(15),
    db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, front: serviceFronts.name }).from(employees).innerJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId))
      .where(and(ne(employees.status, "DEMITIDO"), ilike(employees.name, like), fronts === "ALL" ? undefined : fronts.length ? inArray(employees.serviceFrontId, fronts) : eq(employees.id, -1))).orderBy(asc(employees.name)).limit(15),
  ]);
  return Response.json({ equipment: machines, employees: people });
}
