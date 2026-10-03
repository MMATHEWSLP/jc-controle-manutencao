import type { D1DatabaseLike } from "../db";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";

// ---------------------------------------------------------------------------
// Pendências de dados: tudo que precisa de correção manual e que antes só aparecia numa auditoria
// (saídas sem veículo, equipamento sem frente/leitura/plano/QR, leituras suspeitas, estoque
// negativo, produtos duplicados ou de teste, veículo de terceiro sem capacidade, usuários parados).
// Só leitura, exceto os problemas relatados no Controle Diário, que têm "Resolver" (ver
// resolverProblemaDiario). Cada grupo diz em que tela corrigir. Respeita as frentes que a pessoa enxerga.
// ---------------------------------------------------------------------------

export function canSeePendencias(user: SessionUser) {
  return user.profile === "ADMIN" || user.profile === "GESTOR";
}

type Row = Record<string, unknown>;
export type PendenciaGroup = {
  key: string; title: string; description: string; where: string; severity: "ALTA" | "MEDIA" | "BAIXA";
  total: number; summary?: string; columns: Array<[string, string]>; rows: Row[];
  // Grupo com ação por linha: a tela mostra o botão "Resolver" (usa a coluna "id").
  resolvable?: boolean;
};

const LIMIT = 200;

export async function loadPendencias(d1: D1DatabaseLike, user: SessionUser): Promise<PendenciaGroup[]> {
  const visible = frentesVisiveis(user);
  const fronts = visible === "ALL" ? null : visible;
  const scope = (column: string) => `(?::int[] IS NULL OR ${column} = ANY(?::int[]))`;
  const all = async (query: string, binds: unknown[] = []) => (await d1.prepare(query).bind(...binds).all<Row>()).results;
  const f = [fronts, fronts];

  const [dailyProblems, fuel, fuelTotals, noFront, zeroReading, noPlan, noQr, regressions, jumps, negativeStock, duplicates, testProducts, tankless, idleUsers] = await Promise.all([
    all(`SELECT r.id, r.record_date AS data, e.prefix AS prefixo, sf.name AS frente, coalesce(r.operator_name,'—') AS operador, r.description AS problema,
        CASE WHEN r.import_batch_id IS NULL THEN 'App' ELSE 'Importação' END AS origem
      FROM daily_problem_reports r JOIN equipment e ON e.id=r.equipment_id LEFT JOIN service_fronts sf ON sf.id=r.service_front_id
      WHERE r.status='ABERTO' AND ${scope("coalesce(r.service_front_id, e.service_front_id)")}
      ORDER BY r.record_date DESC, e.sort_key, r.id LIMIT ${LIMIT}`, f),
    all(`SELECT fm.id, fm.movement_date AS data, round(fm.quantity::numeric,2) AS litros, sf.name AS frente, coalesce(fm.responsible,'—') AS responsavel,
        coalesce(nullif(fm.imported_vehicle,''),'(sem texto do veículo)') AS veiculo_informado
      FROM fuel_movements fm JOIN service_fronts sf ON sf.id=fm.service_front_id
      WHERE fm.deleted_at IS NULL AND fm.movement_type='SAIDA' AND NOT fm.balance_adjustment AND fm.equipment_id IS NULL AND fm.third_party_vehicle_id IS NULL
        AND (fm.vehicle_pending OR NOT fm.third_party) AND ${scope("fm.service_front_id")}
      ORDER BY fm.movement_date DESC, fm.id DESC LIMIT ${LIMIT}`, f),
    all(`SELECT count(*)::int AS total, coalesce(round(sum(fm.quantity)::numeric,0),0) AS litros FROM fuel_movements fm
      WHERE fm.deleted_at IS NULL AND fm.movement_type='SAIDA' AND NOT fm.balance_adjustment AND fm.equipment_id IS NULL AND fm.third_party_vehicle_id IS NULL
        AND (fm.vehicle_pending OR NOT fm.third_party) AND ${scope("fm.service_front_id")}`, f),
    visible === "ALL" ? all(`SELECT id, prefix AS prefixo, type AS tipo, status FROM equipment WHERE service_front_id IS NULL AND sold_at IS NULL ORDER BY sort_key`) : Promise.resolve([]),
    all(`SELECT e.id, e.prefix AS prefixo, e.type AS tipo, sf.name AS frente, CASE e.control_type WHEN 'KM' THEN 'KM' WHEN 'HOURS_KM' THEN 'Horas e KM' ELSE 'Horímetro' END AS controle
      FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id
      WHERE e.sold_at IS NULL AND e.status<>'INACTIVE' AND ((e.control_type IN ('HOURS','HOURS_KM') AND e.current_hours=0) OR (e.control_type='KM' AND e.current_km=0))
        AND ${scope("e.service_front_id")} ORDER BY e.sort_key`, f),
    all(`SELECT e.id, e.prefix AS prefixo, e.type AS tipo, sf.name AS frente FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id
      WHERE e.oil_change_enabled AND e.sold_at IS NULL AND NOT EXISTS (SELECT 1 FROM maintenance_plans p WHERE p.equipment_id=e.id AND p.active)
        AND ${scope("e.service_front_id")} ORDER BY e.sort_key`, f),
    all(`SELECT e.id, e.prefix AS prefixo, e.type AS tipo FROM equipment e WHERE coalesce(e.qr_token,'')='' AND e.sold_at IS NULL AND ${scope("e.service_front_id")} ORDER BY e.sort_key`, f),
    all(`SELECT prefixo, data, leitura, anterior FROM (
        SELECT e.prefix AS prefixo, m.reading_date AS data, coalesce(m.hours,m.km) AS leitura, lag(coalesce(m.hours,m.km)) OVER w AS anterior, m.authorized_regression AS autorizada, e.sort_key, e.service_front_id
        FROM meter_readings m JOIN equipment e ON e.id=m.equipment_id WINDOW w AS (PARTITION BY m.equipment_id ORDER BY m.reading_date, m.id)) x
      WHERE leitura < anterior AND NOT autorizada AND ${scope("service_front_id")} ORDER BY sort_key, data LIMIT ${LIMIT}`, f),
    all(`SELECT prefixo, data, leitura, anterior, data_anterior FROM (
        SELECT e.prefix AS prefixo, m.reading_date AS data, coalesce(m.km,m.hours) AS leitura, lag(coalesce(m.km,m.hours)) OVER w AS anterior, lag(m.reading_date) OVER w AS data_anterior,
          CASE WHEN m.km IS NOT NULL THEN 1500 ELSE 24 END AS por_dia, e.sort_key, e.service_front_id
        FROM meter_readings m JOIN equipment e ON e.id=m.equipment_id WINDOW w AS (PARTITION BY m.equipment_id ORDER BY m.reading_date, m.id)) x
      WHERE leitura - anterior > por_dia * greatest(1, (left(data,10)::date - left(data_anterior,10)::date)) AND ${scope("service_front_id")} ORDER BY sort_key, data LIMIT ${LIMIT}`, f),
    all(`SELECT p.tag, p.name AS produto, sf.name AS frente, s.quantity AS saldo FROM product_front_stock s JOIN products p ON p.id=s.product_id JOIN service_fronts sf ON sf.id=s.service_front_id
      WHERE s.quantity < 0 AND ${scope("s.service_front_id")} ORDER BY s.quantity`, f),
    all(`SELECT upper(trim(name)) AS nome, count(*)::int AS cadastros, string_agg(tag, ', ' ORDER BY tag) AS tags FROM products WHERE active GROUP BY 1 HAVING count(*)>1 ORDER BY 2 DESC, 1 LIMIT ${LIMIT}`),
    all(`SELECT p.tag, p.name AS produto, coalesce(sum(s.quantity),0) AS saldo_total FROM products p LEFT JOIN product_front_stock s ON s.product_id=p.id
      WHERE p.active AND p.name ~* '\\mTESTE\\M' GROUP BY p.id ORDER BY p.name`),
    all(`SELECT t.name AS terceiro, v.plate AS placa, CASE WHEN v.tank_capacity_liters IS NULL THEN 'falta' ELSE 'ok' END AS capacidade_tanque,
        CASE WHEN v.expected_consumption IS NULL THEN 'falta' ELSE 'ok' END AS consumo_esperado
      FROM third_party_vehicles v JOIN third_parties t ON t.id=v.third_party_id WHERE v.active AND t.active AND (v.tank_capacity_liters IS NULL OR v.expected_consumption IS NULL) ORDER BY t.name, v.plate`),
    user.profile === "ADMIN" ? all(`SELECT name AS nome, username AS usuario, role AS perfil, coalesce(left(last_access_at,10),'nunca') AS ultimo_acesso FROM users
      WHERE status='ACTIVE' AND (last_access_at IS NULL OR last_access_at < to_char(now() - interval '60 days','YYYY-MM-DD')) ORDER BY last_access_at NULLS FIRST`) : Promise.resolve([]),
  ]);

  const groups: PendenciaGroup[] = [
    { key: "daily-problems", severity: "ALTA", title: "Problemas relatados no Controle Diário", where: "Aqui mesmo: \"Resolver\" em cada linha (ou Manutenção, se precisar de serviço)",
      description: "Problemas que o operador relatou no Controle Diário e ainda não foram resolvidos.", total: dailyProblems.length, resolvable: true,
      columns: [["data", "Data"], ["prefixo", "Equipamento"], ["frente", "Frente"], ["operador", "Operador"], ["problema", "Problema relatado"], ["origem", "Origem"]], rows: dailyProblems },
    { key: "fuel", severity: "ALTA", title: "Saídas de combustível sem veículo", where: "Combustível → Histórico (editar o lançamento e escolher o veículo)",
      description: "Saídas que baixaram o estoque mas não estão ligadas a nenhum equipamento nem terceiro: o consumo por veículo fica errado.",
      total: Number(fuelTotals[0]?.total ?? 0), summary: `${Number(fuelTotals[0]?.litros ?? 0).toLocaleString("pt-BR")} L no total`,
      columns: [["id", "Lançamento"], ["data", "Data"], ["litros", "Litros"], ["frente", "Frente"], ["responsavel", "Responsável"], ["veiculo_informado", "Veículo informado"]], rows: fuel },
    { key: "zero-reading", severity: "MEDIA", title: "Equipamentos com horímetro/KM zerado", where: "Troca de Óleo → Horímetros / KM",
      description: "Sem a leitura atual, a troca de óleo e os alertas não são calculados.", total: zeroReading.length,
      columns: [["prefixo", "Prefixo"], ["tipo", "Tipo"], ["frente", "Frente"], ["controle", "Controle"]], rows: zeroReading },
    { key: "no-plan", severity: "MEDIA", title: "Troca de óleo ligada sem plano", where: "Equipamentos → Cadastro (desligar a troca de óleo) ou Troca de Óleo → planos",
      description: "Equipamentos marcados para troca de óleo sem nenhum plano ativo. Reboques (julietas) normalmente devem ficar com a troca desligada.", total: noPlan.length,
      columns: [["prefixo", "Prefixo"], ["tipo", "Tipo"], ["frente", "Frente"]], rows: noPlan },
    { key: "no-front", severity: "MEDIA", title: "Equipamentos sem frente", where: "Equipamentos → Cadastro / Listagem",
      description: "Não aparecem nos filtros por frente nem para usuários de uma frente só.", total: noFront.length,
      columns: [["prefixo", "Prefixo"], ["tipo", "Tipo"], ["status", "Situação"]], rows: noFront },
    { key: "readings", severity: "MEDIA", title: "Leituras que voltaram sem autorização", where: "Troca de Óleo → Horímetros / KM (corrigir a leitura)",
      description: "Horímetro ou KM menor que a leitura anterior, sem a correção administrativa marcada.", total: regressions.length,
      columns: [["prefixo", "Prefixo"], ["data", "Data"], ["leitura", "Leitura"], ["anterior", "Anterior"]], rows: regressions },
    { key: "jumps", severity: "MEDIA", title: "Saltos de leitura impossíveis", where: "Troca de Óleo → Horímetros / KM",
      description: "Mais de 24 h por dia de horímetro ou 1.500 km por dia desde a leitura anterior — provável erro de digitação.", total: jumps.length,
      columns: [["prefixo", "Prefixo"], ["data_anterior", "De"], ["anterior", "Leitura anterior"], ["data", "Até"], ["leitura", "Leitura"]], rows: jumps },
    { key: "negative-stock", severity: "MEDIA", title: "Estoque negativo", where: "Produtos → ficha do produto (ajuste com inventário)",
      description: "Saídas lançadas sem saldo. Confira com uma contagem física.", total: negativeStock.length,
      columns: [["tag", "TAG"], ["produto", "Produto"], ["frente", "Frente"], ["saldo", "Saldo"]], rows: negativeStock },
    { key: "test-products", severity: "BAIXA", title: "Produtos de teste", where: "Produtos (desativar ou excluir)",
      description: "Cadastros com \"TESTE\" no nome ainda ativos.", total: testProducts.length,
      columns: [["tag", "TAG"], ["produto", "Produto"], ["saldo_total", "Saldo total"]], rows: testProducts },
    { key: "duplicates", severity: "BAIXA", title: "Produtos com o mesmo nome", where: "Produtos (colocar a referência no nome ou juntar cadastros)",
      description: "Na busca e na requisição não dá para saber qual é qual.", total: duplicates.length,
      columns: [["nome", "Nome"], ["cadastros", "Cadastros"], ["tags", "TAGs"]], rows: duplicates },
    { key: "tankless", severity: "BAIXA", title: "Veículos de terceiros sem capacidade/consumo", where: "Produtos → Terceiros (editar o veículo)",
      description: "Sem esses dados o sistema não avisa abastecimento acima do tanque nem consumo fora da média.", total: tankless.length,
      columns: [["terceiro", "Terceiro"], ["placa", "Placa"], ["capacidade_tanque", "Capacidade"], ["consumo_esperado", "Consumo esperado"]], rows: tankless },
    { key: "no-qr", severity: "BAIXA", title: "Equipamentos sem QR Code", where: "Troca de Óleo → QR Codes", description: "Não dá para imprimir a etiqueta.",
      total: noQr.length, columns: [["prefixo", "Prefixo"], ["tipo", "Tipo"]], rows: noQr },
  ];
  if (user.profile === "ADMIN") groups.push({ key: "idle-users", severity: "BAIXA", title: "Usuários sem acesso há mais de 60 dias", where: "Usuários (inativar se não precisa mais)",
    description: "Contas ativas que não são usadas.", total: idleUsers.length,
    columns: [["nome", "Nome"], ["usuario", "Usuário"], ["perfil", "Perfil"], ["ultimo_acesso", "Último acesso"]], rows: idleUsers });
  return groups.map((group) => ({ ...group, rows: group.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : typeof value === "object" ? String(value) : value]))) }));
}

// Marca um problema relatado no Controle Diário como resolvido (com uma observação opcional).
export async function resolverProblemaDiario(d1: D1DatabaseLike, user: SessionUser, id: number, note: string) {
  const visible = frentesVisiveis(user);
  const fronts = visible === "ALL" ? null : visible;
  const row = await d1.prepare(`SELECT r.id, r.status FROM daily_problem_reports r JOIN equipment e ON e.id=r.equipment_id
    WHERE r.id=? AND (?::int[] IS NULL OR coalesce(r.service_front_id, e.service_front_id) = ANY(?::int[]))`).bind(id, fronts, fronts).first<{ id: number; status: string }>();
  if (!row) return { ok: false as const, status: 404, error: "Problema não encontrado." };
  if (row.status === "RESOLVIDO") return { ok: false as const, status: 409, error: "Este problema já foi resolvido." };
  const now = new Date().toISOString();
  const cleanNote = note.trim().slice(0, 500) || null;
  await d1.batch([
    d1.prepare(`UPDATE daily_problem_reports SET status='RESOLVIDO', resolved_at=?, resolved_by=?, resolution_note=?, updated_at=? WHERE id=?`).bind(now, user.id, cleanNote, now, id),
    d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(user.id, "DAILY_PROBLEM", String(id), "PROBLEMA DO CONTROLE DIÁRIO RESOLVIDO", JSON.stringify({ status: "ABERTO" }), JSON.stringify({ status: "RESOLVIDO", note: cleanNote }), now),
  ]);
  return { ok: true as const };
}
