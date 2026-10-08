import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";

// ---------------------------------------------------------------------------
// Relatórios do Controle Diário (aba Relatórios): produção por frente/local/operador/equipamento,
// KM/horas trabalhadas e a conferência "Diário x Combustível" (diesel informado pelo operador x
// saídas lançadas no módulo Combustível). Registros do app e importados, nas frentes que a pessoa vê.
// ---------------------------------------------------------------------------
export type ReportFilters = { from: string; to: string; frontId: number | null; equipmentId: number | null; operator: string; location: string; origin: "" | "APP" | "IMPORTADO" };
export const AGRUPAMENTOS = { frente: "Frente", local: "Local", operador: "Operador", equipamento: "Equipamento" } as const;
export type Agrupamento = keyof typeof AGRUPAMENTOS;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function parseReportFilters(params: URLSearchParams, today: string): ReportFilters {
  const from = ISO.test(params.get("de") ?? "") ? params.get("de")! : `${today.slice(0, 7)}-01`;
  const to = ISO.test(params.get("ate") ?? "") ? params.get("ate")! : today;
  const origin = params.get("origem");
  return {
    from: from <= to ? from : to, to: from <= to ? to : from, frontId: Number(params.get("frente")) || null, equipmentId: Number(params.get("equipamento")) || null,
    operator: (params.get("operador") ?? "").trim().slice(0, 80), location: (params.get("local") ?? "").trim().slice(0, 80), origin: origin === "APP" || origin === "IMPORTADO" ? origin : "",
  };
}

// Operador exibido: sem operador / cadastro de campo / nome digitado / a própria conta (login de campo).
const OPERADOR = sql`CASE WHEN d.no_operator THEN 'Sem operador' ELSE coalesce(fo.name, d.operator_name, u.name) END`;
const FRENTE_ID = sql`coalesce(d.service_front_id, d.official_service_front_id)`;

function onde(user: SessionUser, f: ReportFilters): SQL {
  const partes: SQL[] = [sql`d.record_date BETWEEN ${f.from} AND ${f.to}`];
  const visiveis = frentesVisiveis(user);
  if (visiveis !== "ALL") partes.push(visiveis.length ? sql`${FRENTE_ID} = ANY(${visiveis}::int[])` : sql`false`);
  if (f.frontId) partes.push(sql`${FRENTE_ID} = ${f.frontId}`);
  if (f.equipmentId) partes.push(sql`d.equipment_id = ${f.equipmentId}`);
  if (f.operator) partes.push(sql`${OPERADOR} ILIKE ${`%${f.operator}%`}`);
  if (f.location) partes.push(sql`coalesce(d.location, '') ILIKE ${`%${f.location}%`}`);
  if (f.origin === "APP") partes.push(sql`d.import_batch_id IS NULL`);
  if (f.origin === "IMPORTADO") partes.push(sql`d.import_batch_id IS NOT NULL`);
  return sql.join(partes, sql` AND `);
}

// As contagens das viagens usam count(t.id): com count(*) e o FILTER só sobre "d", o Postgres trata o
// agregado como da consulta de fora e recusa ("aggregate functions are not allowed in FROM clause").
const BASE = sql`FROM daily_records d
  JOIN equipment e ON e.id = d.equipment_id
  JOIN users u ON u.id = d.user_id
  LEFT JOIN users fo ON fo.id = d.field_operator_id
  LEFT JOIN service_fronts sf ON sf.id = ${FRENTE_ID}
  LEFT JOIN LATERAL (SELECT count(t.id) FILTER (WHERE d.production_type = 'PORTO') AS porto, count(t.id) FILTER (WHERE d.production_type = 'BALDEIO') AS baldeio,
    coalesce(sum(t.logs_quantity), 0) AS toras, sum(t.meters) AS volume FROM daily_record_trips t WHERE t.daily_record_id = d.id) tr ON true
  LEFT JOIN LATERAL (SELECT coalesce(sum(f.liters), 0) AS litros FROM daily_record_fuelings f WHERE f.daily_record_id = d.id) fu ON true`;

const CHAVE: Record<Agrupamento, SQL> = {
  frente: sql`coalesce(sf.name, 'Sem frente')`, local: sql`coalesce(nullif(trim(d.location), ''), 'Sem local')`, operador: OPERADOR, equipamento: sql`e.prefix`,
};

export async function producao(user: SessionUser, f: ReportFilters, por: Agrupamento) {
  const db = await getDb();
  const chave = CHAVE[por];
  const result = await db.execute(sql`SELECT ${chave} AS chave, count(*)::int AS registros, count(*) FILTER (WHERE d.import_batch_id IS NOT NULL)::int AS importados,
      count(*) FILTER (WHERE d.review_status = 'CONFERIR')::int AS conferir,
      coalesce(sum(d.end_reading - d.start_reading) FILTER (WHERE d.reading_unit = 'KM' AND d.end_reading >= d.start_reading AND d.review_status = 'OK'), 0)::float8 AS km,
      coalesce(sum(d.end_reading - d.start_reading) FILTER (WHERE d.reading_unit = 'HOURS' AND d.end_reading >= d.start_reading AND d.review_status = 'OK'), 0)::float8 AS horas,
      coalesce(sum(coalesce(d.port_trips, tr.porto)), 0)::int AS viagens_porto, coalesce(sum(coalesce(d.port_volume_m3, tr.volume)), 0)::float8 AS volume_porto,
      coalesce(sum(coalesce(d.port_logs, CASE WHEN d.production_type = 'PORTO' THEN tr.toras END)), 0)::int AS toras_porto,
      coalesce(sum(coalesce(d.baldeio_trips, tr.baldeio)), 0)::int AS viagens_baldeio,
      coalesce(sum(coalesce(d.total_trips, tr.porto + tr.baldeio)), 0)::int AS viagens,
      coalesce(sum(coalesce(d.reported_diesel_liters, 0) + fu.litros), 0)::float8 AS diesel_informado
    ${BASE} WHERE ${onde(user, f)} GROUP BY 1 ORDER BY viagens DESC, registros DESC, 1`);
  return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => ({
    chave: String(row.chave), registros: Number(row.registros), importados: Number(row.importados), conferir: Number(row.conferir), km: Number(row.km), horas: Number(row.horas),
    viagensPorto: Number(row.viagens_porto), volumePorto: Number(row.volume_porto), torasPorto: Number(row.toras_porto), viagensBaldeio: Number(row.viagens_baldeio), viagens: Number(row.viagens),
    dieselInformado: Number(row.diesel_informado),
  }));
}

// Diário x Combustível por equipamento e dia: litros informados no diário (campo do registro +
// abastecimentos do formulário) x saídas de diesel lançadas no Combustível (não excluídas).
export async function dieselConferencia(user: SessionUser, f: ReportFilters) {
  const db = await getDb();
  const visiveis = frentesVisiveis(user);
  const frenteComb = visiveis === "ALL" ? sql`true` : visiveis.length ? sql`fm.service_front_id = ANY(${visiveis}::int[])` : sql`false`;
  const result = await db.execute(sql`WITH diario AS (
      SELECT d.equipment_id, d.record_date AS dia, sum(coalesce(d.reported_diesel_liters, 0) + fu.litros)::float8 AS litros, count(*)::int AS registros,
        string_agg(DISTINCT ${OPERADOR}, ', ') AS operadores, bool_or(d.diesel_note IS NOT NULL) AS nota
      ${BASE} WHERE ${onde(user, f)} GROUP BY 1, 2
    ), comb AS (
      SELECT fm.equipment_id, fm.movement_date AS dia, sum(fm.quantity)::float8 AS litros, count(*)::int AS saidas FROM fuel_movements fm
      WHERE fm.deleted_at IS NULL AND fm.movement_type = 'SAIDA' AND NOT fm.balance_adjustment AND fm.equipment_id IS NOT NULL AND fm.movement_date BETWEEN ${f.from} AND ${f.to} AND ${frenteComb}
        ${f.frontId ? sql`AND fm.service_front_id = ${f.frontId}` : sql``} ${f.equipmentId ? sql`AND fm.equipment_id = ${f.equipmentId}` : sql``}
      GROUP BY 1, 2
    )
    SELECT coalesce(di.equipment_id, co.equipment_id) AS equipment_id, e.prefix, coalesce(di.dia, co.dia) AS dia, coalesce(di.litros, 0) AS diario, coalesce(co.litros, 0) AS combustivel,
      coalesce(di.registros, 0) AS registros, coalesce(co.saidas, 0) AS saidas, di.operadores, coalesce(di.nota, false) AS nota
    FROM diario di FULL JOIN comb co ON co.equipment_id = di.equipment_id AND co.dia = di.dia
    JOIN equipment e ON e.id = coalesce(di.equipment_id, co.equipment_id)
    ${f.operator || f.location || f.origin ? sql`WHERE di.equipment_id IS NOT NULL` : sql``}
    ORDER BY abs(coalesce(di.litros, 0) - coalesce(co.litros, 0)) DESC, 3, 2 LIMIT 5000`);
  return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => ({
    equipmentId: Number(row.equipment_id), prefixo: String(row.prefix), dia: String(row.dia), diario: Number(row.diario), combustivel: Number(row.combustivel),
    diferenca: Math.round((Number(row.diario) - Number(row.combustivel)) * 100) / 100, registros: Number(row.registros), saidas: Number(row.saidas), operadores: row.operadores ? String(row.operadores) : null, nota: Boolean(row.nota),
  }));
}
