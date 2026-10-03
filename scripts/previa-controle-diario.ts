// Prévia (SOMENTE LEITURA) da importação do Controle Diário de setembro/2026 contra o banco:
// equipamentos/frentes/operadores/locais encontrados ou não, linhas "Conferir", registros do mesmo
// dia, duplicados já existentes, leituras que atualizariam o equipamento, problemas relatados e a
// conferência Diário x Combustível. Não grava nada (sessão READ ONLY).
// Uso: DATABASE_URL=... npx tsx scripts/previa-controle-diario.ts [arquivo.xlsx]
import "dotenv/config";
import ExcelJS from "exceljs";
process.env.DATABASE_READ_ONLY = "1";

const ARQUIVO = process.argv[2] ?? "importacoes/Controle_Diario_Setembro_LIMPO.xlsx";
const cel = (v: ExcelJS.CellValue): unknown => (v && typeof v === "object" && !(v instanceof Date) ? ("result" in v ? v.result : "richText" in v ? v.richText.map((p) => p.text).join("") : "text" in v ? v.text : null) : v);
const n = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });

async function main() {
  const { getDb } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const R = await import("../lib/daily-import-rules");
  const { semelhanca, SEMELHANCA_ROTULO } = await import("../lib/field-operators-rules");
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(ARQUIVO);
  const ws = wb.getWorksheet("Importar") ?? wb.worksheets[0];
  const head = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => String(cel(v) ?? ""));
  const { indices, faltando } = R.mapearCabecalhoDiario(head);
  if (faltando.length) throw new Error(`Colunas faltando: ${faltando.join(", ")}`);
  const linhas: ReturnType<typeof R.lerLinhaDiario>[] = [];
  for (let i = 2; i <= ws.rowCount; i++) { const vals = (ws.getRow(i).values as ExcelJS.CellValue[]).slice(1).map(cel); if (vals.some((v) => v !== null && v !== undefined && v !== "")) linhas.push(R.lerLinhaDiario(vals, indices, i)); }
  const de = linhas.map((l) => l.data!).sort()[0], ate = linhas.map((l) => l.data!).sort().at(-1)!;

  const db = await getDb();
  const q = async <T,>(texto: string) => ((await db.execute(sql.raw(texto))) as unknown as { rows: T[] }).rows;
  const [equip, frentes, campo, funcionarios, existentes, combustivel] = await Promise.all([
    q<{ id: number; prefix: string; code: string; type: string; model: string; control_type: string; current_hours: number; current_km: number; front: string | null; status: string }>(
      `SELECT e.id, e.prefix, e.code, e.type, e.model, e.control_type, e.current_hours, e.current_km, sf.name AS front, e.status FROM equipment e LEFT JOIN service_fronts sf ON sf.id = e.service_front_id`),
    q<{ id: number; name: string; active: boolean }>(`SELECT id, name, active FROM service_fronts`),
    q<{ id: number; name: string; status: string; employee_id: number | null }>(`SELECT id, name, status, employee_id FROM users WHERE role = 'CAMPO'`),
    q<{ id: number; name: string; status: string; job_title: string }>(`SELECT id, name, status, job_title FROM employees`),
    q<{ equipment_id: number; record_date: string; start_reading: number | null; end_reading: number | null }>(`SELECT equipment_id, record_date, start_reading, end_reading FROM daily_records WHERE record_date BETWEEN '${de}' AND '${ate}'`),
    q<{ equipment_id: number; dia: string; litros: number }>(`SELECT equipment_id, movement_date AS dia, sum(quantity)::float AS litros FROM fuel_movements WHERE deleted_at IS NULL AND movement_type = 'SAIDA' AND NOT balance_adjustment AND equipment_id IS NOT NULL AND movement_date BETWEEN '${de}' AND '${ate}' GROUP BY 1, 2`),
  ]);
  const porPrefixo = new Map<string, typeof equip>();
  for (const e of equip) for (const chave of new Set([R.chaveEquipamento(e.prefix), R.chaveEquipamento(e.code)])) porPrefixo.set(chave, [...(porPrefixo.get(chave) ?? []), e]);

  console.log(`=== PRÉVIA — Controle Diário ${de} a ${ate} (nada foi gravado) ===`);
  console.log("Totais da planilha:", JSON.stringify(R.totaisDiario(linhas)));

  // Equipamentos
  const codigos = [...new Set(linhas.map((l) => l.equipamento))].sort();
  const naoAchados = codigos.filter((c) => !porPrefixo.has(c));
  const ambiguos = codigos.filter((c) => (porPrefixo.get(c)?.length ?? 0) > 1);
  console.log(`\n[EQUIPAMENTOS] ${codigos.length} códigos · encontrados ${codigos.length - naoAchados.length} · não encontrados ${naoAchados.length} · mais de um cadastro com o código ${ambiguos.length}`);
  for (const c of naoAchados) { const ls = linhas.filter((l) => l.equipamento === c); console.log(`  NÃO ENCONTRADO ${c}: ${ls.length} linha(s), frentes ${[...new Set(ls.map((l) => l.frente))].join("/")}, leituras ${ls[0].leituraInicial}→${ls.at(-1)!.leituraFinal}`); }
  for (const c of ambiguos) console.log(`  CÓDIGO REPETIDO NO CADASTRO ${c}: ${porPrefixo.get(c)!.map((e) => `#${e.id} ${e.prefix}/${e.code} ${e.type} ${e.model}`).join(" | ")}`);
  for (const c of codigos) {
    const g = R.gruposDeEscala(linhas.filter((l) => l.equipamento === c)); if (!g) continue;
    console.log(`  DOIS EQUIPAMENTOS NO CÓDIGO ${c}:`);
    for (const [nome, grupo] of [["escala menor", g.baixo], ["escala maior", g.alto]] as const) console.log(`    ${nome}: ${grupo.linhas.length} linhas, ${grupo.datas[0]}→${grupo.datas[1]}, leituras ${grupo.primeira}→${grupo.ultima}, operadores ${grupo.operadores.join(", ")}`);
    for (const e of porPrefixo.get(c) ?? []) console.log(`    cadastro #${e.id} ${e.prefix} (${e.code}) ${e.type} ${e.model} · ${e.control_type} · atual ${e.current_hours} h / ${e.current_km} km · ${e.front ?? "sem frente"} · ${e.status}`);
    const parecidos = equip.filter((e) => e.prefix.toUpperCase().startsWith(c.slice(0, 2)) && !porPrefixo.get(c)?.some((x) => x.id === e.id));
    for (const e of parecidos) console.log(`    outro ${c.slice(0, 2)} no cadastro: #${e.id} ${e.prefix} (${e.code}) ${e.type} ${e.model} · ${e.control_type} · atual ${e.current_hours} h / ${e.current_km} km · ${e.front ?? "sem frente"} · ${e.status}`);
  }
  const unidadeErrada = codigos.filter((c) => porPrefixo.get(c)?.length === 1 && !R.gruposDeEscala(linhas.filter((l) => l.equipamento === c))).flatMap((c) => {
    const e = porPrefixo.get(c)![0]; const max = Math.max(...linhas.filter((l) => l.equipamento === c).map((l) => l.leituraFinal ?? 0));
    const atual = e.control_type === "KM" ? e.current_km : e.current_hours;
    return atual > 0 && (max / atual > 20 || atual / Math.max(1, max) > 20) ? [`${c}: planilha até ${max}, cadastro ${atual} (${e.control_type})`] : [];
  });
  if (unidadeErrada.length) console.log(`  ESCALA DIFERENTE DO CADASTRO (conferir unidade/código): ${unidadeErrada.join(" · ")}`);

  // Frentes
  const nomesFrente = [...new Set(linhas.map((l) => l.frente))];
  console.log(`\n[FRENTES] ${nomesFrente.map((f) => `${f}=${frentes.find((x) => R.nameKey(x.name) === R.nameKey(f)) ? "ok" : "NÃO ENCONTRADA"}`).join(" · ")}`);

  // Operadores
  const ops = [...new Set(linhas.filter((l) => l.operador && !l.semOperador).map((l) => l.operador!))].sort();
  const achado = (nome: string) => campo.find((u) => R.nameKey(u.name) === R.nameKey(nome));
  const okCampo = ops.filter((o) => achado(o));
  const okFunc = ops.filter((o) => !achado(o) && funcionarios.some((f) => R.nameKey(f.name) === R.nameKey(o) && f.status !== "DEMITIDO"));
  const resto = ops.filter((o) => !okCampo.includes(o) && !okFunc.includes(o));
  console.log(`\n[OPERADORES] ${ops.length} nomes · ${linhas.filter((l) => l.semOperador).length} linhas "Sem operador = SIM"`);
  console.log(`  já são funcionários de campo: ${okCampo.length}${okCampo.some((o) => achado(o)!.status !== "ACTIVE") ? ` (inativos: ${okCampo.filter((o) => achado(o)!.status !== "ACTIVE").join(", ")})` : ""}`);
  console.log(`  só no cadastro de Funcionários (sem acesso de campo): ${okFunc.length}${okFunc.length ? ` — ${okFunc.join(", ")}` : ""}`);
  console.log(`  não encontrados com nome igual: ${resto.length}`);
  for (const o of resto) {
    const sug = [...campo.map((u) => ({ nome: u.name, tipo: "campo", s: semelhanca(o, u.name) })), ...funcionarios.filter((f) => f.status !== "DEMITIDO").map((f) => ({ nome: f.name, tipo: "funcionário", s: semelhanca(o, f.name) }))].filter((x) => x.s);
    console.log(`    ${o} (${linhas.filter((l) => l.operador === o).length} lanç.)${sug.length ? ` → parecidos: ${sug.slice(0, 3).map((x) => `${x.nome} [${x.tipo}, ${SEMELHANCA_ROTULO[x.s!].toLowerCase()}]`).join("; ")}` : " → nenhum parecido"}`);
  }

  // Locais
  const locais = [...new Set(linhas.map((l) => l.local).filter(Boolean))];
  const apelidos = new Set(linhas.map((l) => `${l.local}|${l.localOriginal}`).filter((x) => !x.startsWith("null")));
  console.log(`\n[LOCAIS] ${locais.length} locais padronizados (cadastro novo) · ${apelidos.size} apelidos (Local original) · linhas sem local: ${linhas.filter((l) => !l.local).length}`);

  // Conferir, mesmo dia, duplicados
  const conferir: string[] = []; const avisos: string[] = [];
  for (const c of codigos) {
    const ls = linhas.filter((l) => l.equipamento === c); const g = R.gruposDeEscala(ls);
    const grupos = g ? [ls.filter((l) => g.baixo.linhas.includes(l.linha)), ls.filter((l) => g.alto.linhas.includes(l.linha))] : [ls];
    for (const grupo of grupos) {
      const r = R.conferirLeituras(grupo);
      for (const [linha, m] of r.conferir) { const l = linhas.find((x) => x.linha === linha)!; conferir.push(`linha ${linha} ${l.data} ${c} ${l.leituraInicial}→${l.leituraFinal} ${l.operador ?? "(sem operador)"} — ${m.map((x) => R.MOTIVO_ROTULO[x]).join("; ")}`); }
      for (const [linha, m] of r.avisos) { const l = linhas.find((x) => x.linha === linha)!; avisos.push(`linha ${linha} ${l.data} ${c} ${l.leituraInicial}→${l.leituraFinal} — ${m.map((x) => R.MOTIVO_ROTULO[x]).join("; ")}`); }
    }
  }
  console.log(`\n[CONFERIR] ${conferir.length} linha(s) — entram com status "Conferir" e não atualizam a leitura do equipamento:`); conferir.forEach((x) => console.log(`  ${x}`));
  console.log(`\n[MESMO DIA] ${avisos.length} linha(s) sinalizada(s) (importadas separadas):`); avisos.forEach((x) => console.log(`  ${x}`));
  const duplicados = linhas.filter((l) => { const e = porPrefixo.get(l.equipamento); return e?.length === 1 && existentes.some((x) => x.equipment_id === e[0].id && x.record_date === l.data && x.start_reading === l.leituraInicial && x.end_reading === l.leituraFinal); });
  console.log(`\n[JÁ EXISTEM NO SISTEMA] ${duplicados.length} (serão ignorados) · registros do Controle Diário no período no banco: ${existentes.length}`);

  // Leituras
  const atualiza = codigos.filter((c) => porPrefixo.get(c)?.length === 1 && !R.gruposDeEscala(linhas.filter((l) => l.equipamento === c))).map((c) => {
    const e = porPrefixo.get(c)![0]; const max = Math.max(...linhas.filter((l) => l.equipamento === c).map((l) => l.leituraFinal ?? 0));
    const atual = e.control_type === "KM" ? e.current_km : e.current_hours; return { c, atual, max, sobe: max > atual };
  });
  console.log(`\n[LEITURAS] ${linhas.filter((l) => l.leituraFinal !== null).length} leituras finais entram no histórico (origem CONTROLE_DIARIO) · equipamentos cuja leitura atual subiria: ${atualiza.filter((x) => x.sobe).length} · já com leitura maior no cadastro: ${atualiza.filter((x) => !x.sobe).length}`);
  for (const x of atualiza.filter((y) => !y.sobe)) console.log(`  mantém ${x.c}: cadastro ${x.atual} ≥ planilha ${x.max}`);

  // Problemas
  const problemas = linhas.filter((l) => l.problema);
  console.log(`\n[PROBLEMAS RELATADOS] ${problemas.length} (nenhuma pendência criada por padrão):`);
  problemas.forEach((l) => console.log(`  linha ${l.linha} ${l.data} ${l.equipamento} ${l.frente} ${l.operador ?? "(sem operador)"}: ${l.problema}`));

  // Diário x Combustível
  const diesel = new Map<string, { diario: number; comb: number }>();
  for (const l of linhas) { const e = porPrefixo.get(l.equipamento); if (e?.length !== 1 || !l.diesel) continue; const k = `${l.equipamento}`; const x = diesel.get(k) ?? { diario: 0, comb: 0 }; x.diario += l.diesel; diesel.set(k, x); }
  for (const f of combustivel) { const e = equip.find((x) => x.id === f.equipment_id); if (!e) continue; const k = R.chaveEquipamento(e.prefix); const x = diesel.get(k) ?? { diario: 0, comb: 0 }; x.comb += Number(f.litros); diesel.set(k, x); }
  const lista = [...diesel.entries()].map(([k, x]) => ({ k, ...x, dif: x.diario - x.comb })).sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));
  console.log(`\n[DIÁRIO x COMBUSTÍVEL] diário ${n(lista.reduce((s, x) => s + x.diario, 0))} L · Combustível ${n(lista.reduce((s, x) => s + x.comb, 0))} L · maiores diferenças:`);
  lista.slice(0, 15).forEach((x) => console.log(`  ${x.k}: diário ${n(x.diario)} L · Combustível ${n(x.comb)} L · diferença ${n(x.dif)} L`));
  process.exit(0);
}
main().catch((error) => { console.error(error); process.exit(1); });
