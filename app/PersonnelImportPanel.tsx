"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// FUNCIONÁRIOS → "Importar do sistema de pessoal" (só ADMIN). Prévia sem gravar, separada por aba
// (criados, atualizados campo a campo, ignorados, casamentos por nome para confirmar, funções novas e
// linhas com erro); depois "Confirmar importação" grava em blocos e permite "Desfazer importação".
// A prévia nunca mostra CPF, salário, nascimento ou motivos: só "preenchido"/"alterado".
// ---------------------------------------------------------------------------
type Candidate = { id: number; name: string; front: string | null; company: string; registration: string | null; status: string };
type Person = {
  externalId: string; row: number; name: string; front: string; company: string; jobTitle: string; active: boolean;
  how: "ID" | "CPF" | "MATRICULA" | "NOME" | "PARECIDO" | "ESCOLHIDO" | "NOVO"; employeeId: number | null; employee: Candidate | null; candidates: Candidate[];
  action: "CRIAR" | "ATUALIZAR" | "SEM_MUDANCA" | "ERRO";
  changes: Array<{ field: string; label: string; from: string | null; to: string | null }>;
  history: { cycles: number; absences: number; transfers: number; dismissals: number; kept: string[] };
  warnings: string[]; errors: string[];
};
type Row = { sheet: string; row: number; name: string; reason: string };
type Preview = {
  fileName: string; hash: string; blocks: number; exportDate: string | null;
  totals: { collaborators: number; active: number; dismissed: number; cycles: number; history: number; historyTaken: number; historySold: number; onLeave: number; traveling: number; restricted: number; restrictedRows: number };
  sheets: Array<{ sheet: string; rows: number; used: number; ignored: number; note: string }>;
  people: Person[];
  counts: { create: number; update: number; unchanged: number; errors: number; byName: number; cyclesNew: number; cyclesUpdated: number; absencesNew: number; absencesUpdated: number; transfersNew: number; dismissalsNew: number; dismissalsUpdated: number };
  ignored: Row[]; unlinked: Row[]; checks: string[];
  functions: {
    list: Array<{ name: string; original: string[]; people: number; operates: boolean }>; create: Array<{ name: string; operates: boolean; people: number }>;
    aliases: Array<{ alias: string; name: string }>; markOperates: Array<{ id: number; name: string }>; looksAlike: Array<{ functions: string[] }>;
  };
  companiesToCreate: string[];
  fieldAccess: { link: Array<{ name: string; userId: number }>; deactivate: Array<{ name: string; reason: string }>; operatorsWithoutAccess: Array<{ name: string; jobTitle: string; front: string }> };
};
type Batch = { id: number; fileName: string; exportDate: string | null; status: "EM_ANDAMENTO" | "CONCLUIDO" | "DESFEITO"; summary: Record<string, number> | null; createdAt: string; finishedAt: string | null; undoneAt: string | null; importedBy: string };
type Decision = number | "NOVO";

// Totais da exportação de 03/10/2026 (conferência combinada com o ADMIN).
const EXPECTED = { date: "2026-10-03", collaborators: 416, active: 347, dismissed: 69, cycles: 345, history: 116, historyTaken: 111, historySold: 5, onLeave: 20, traveling: 25, restricted: 20 };
const HOW: Record<Person["how"], string> = { ID: "ID sistema", CPF: "CPF", MATRICULA: "Matrícula + empresa", NOME: "Só pelo nome", PARECIDO: "Nome parecido", ESCOLHIDO: "Escolhido na prévia", NOVO: "Novo" };
const STATUS: Record<Batch["status"], string> = { EM_ANDAMENTO: "Em andamento", CONCLUIDO: "Concluída", DESFEITO: "Desfeita" };
const TABLE_LABEL: Record<string, string> = { employees: "funcionários", employee_leave_cycles: "ciclos de folga", employee_absences: "afastamentos", employee_transfers: "histórico de frentes", employee_dismissals: "desligamentos", job_functions: "funções", job_function_aliases: "grafias de função", companies: "empresas", users: "acessos de campo" };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}
const day = (value: string | null) => (value ? value.slice(0, 10).split("-").reverse().join("/") : "—");
const n = (value: number) => value.toLocaleString("pt-BR");

export default function PersonnelImportPanel({ flash, changed }: { flash: (message: string) => void; changed: () => Promise<void> | void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; step: string } | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState("");

  const loadBatches = useCallback(() => { call<{ batches: Batch[] }>("/api/employees/import").then((data) => setBatches(data.batches)).catch(() => undefined); }, []);
  useEffect(() => { loadBatches(); }, [loadBatches]);

  const form = (action: string, extra: Record<string, string> = {}) => {
    const body = new FormData();
    body.set("acao", action);
    if (file) body.set("arquivo", file);
    body.set("decisoes", JSON.stringify(decisions));
    for (const [key, value] of Object.entries(extra)) body.set(key, value);
    return { method: "POST", body };
  };

  async function runPreview() {
    if (!file) return;
    setBusy(true); setError(""); setResult("");
    try { setPreview(await call<Preview>("/api/employees/import", form("previa"))); setStale(false); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao ler a exportação."); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!preview || !file) return;
    if (!window.confirm(`Confirmar a importação? ${preview.counts.create} funcionário(s) serão criados e ${preview.counts.update} atualizados, com o histórico de folgas, afastamentos, frentes e desligamentos. Dá para desfazer depois em "Importações".`)) return;
    setBusy(true); setError(""); setResult("");
    try {
      setProgress({ done: 0, total: preview.blocks + 1, step: "Criando o lote, empresas e funções..." });
      const started = await call<{ batchId: number; blocks: number }>("/api/employees/import", form("iniciar"));
      const failed: Array<{ name: string; error: string }> = [];
      let saved = 0, deactivated = 0;
      for (let block = 0; block < started.blocks; block++) {
        setProgress({ done: block + 1, total: started.blocks + 1, step: `Gravando pessoas: bloco ${block + 1} de ${started.blocks}...` });
        const answer = await call<{ saved: number; deactivated: number; failed: Array<{ name: string; error: string }> }>("/api/employees/import", form("bloco", { loteId: String(started.batchId), bloco: String(block) }));
        saved += answer.saved; deactivated += answer.deactivated; failed.push(...answer.failed);
      }
      await call("/api/employees/import", form("concluir", { loteId: String(started.batchId) }));
      const message = `Importação concluída (lote ${started.batchId}): ${saved} funcionário(s) gravados${deactivated ? `, ${deactivated} acesso(s) de campo desativados` : ""}${failed.length ? `. ${failed.length} com erro: ${failed.map((item) => `${item.name} (${item.error})`).join("; ")}` : "."}`;
      setResult(message); flash(message.slice(0, 160));
      setPreview(null);
      await changed();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao importar. O que já foi gravado pode ser desfeito em Importações."); }
    finally { setBusy(false); setProgress(null); loadBatches(); }
  }

  async function undo(batch: Batch) {
    if (!window.confirm(`Desfazer a importação do lote ${batch.id}? Os funcionários e registros criados por ela serão apagados e o que ela alterou volta ao valor anterior (inclusive alterações feitas depois nesses campos).`)) return;
    setBusy(true); setError("");
    try {
      const answer = await call<{ undone: number; failed: string[] }>(`/api/employees/import/${batch.id}`, { method: "DELETE" });
      const message = `Importação desfeita: ${answer.undone} registro(s) revertidos${answer.failed.length ? `; ${answer.failed.length} não puderam ser desfeitos (${answer.failed.slice(0, 5).join("; ")})` : ""}.`;
      setResult(message); flash(message.slice(0, 160));
      await changed();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao desfazer."); }
    finally { setBusy(false); loadBatches(); }
  }

  function decide(externalId: string, value: Decision) {
    setDecisions((current) => ({ ...current, [externalId]: value }));
    setStale(true);
  }

  const people = useMemo(() => preview?.people ?? [], [preview]);
  const key = filter.trim().toLocaleLowerCase("pt-BR");
  const visible = (person: Person) => !key || `${person.name} ${person.front} ${person.company} ${person.jobTitle}`.toLocaleLowerCase("pt-BR").includes(key);
  // Casamentos para confirmar: só pelo nome, parecidos e os que o ADMIN já decidiu (para poder voltar atrás).
  const byName = people.filter((person) => person.how === "NOME" || person.how === "PARECIDO" || person.how === "ESCOLHIDO" || (person.how === "NOVO" && person.candidates.length > 0));
  const created = people.filter((person) => person.action === "CRIAR" && visible(person));
  const updated = people.filter((person) => person.action === "ATUALIZAR" && visible(person));
  const errors = people.filter((person) => person.action === "ERRO");
  const warned = people.filter((person) => person.warnings.length || person.history.kept.length);
  const runningBatch = batches.find((batch) => batch.status === "EM_ANDAMENTO");
  const t = preview?.totals;
  const sameExport = preview?.exportDate === EXPECTED.date;

  return <article className="panel module-panel daily-import">
    <div className="daily-operators-head">
      <div><strong>Importar do sistema de pessoal</strong><span>Exportação .xlsx com as abas Colaboradores, Ciclos de folga, Histórico de folgas, De folga, Em viagem, Afastamentos, Ausências, Transferências, Movimentações e Lista de restrição. A prévia não grava nada. Assinaturas, pendências e faltas são ignoradas; situação, dias restantes e alertas de folga são calculados pelo sistema a partir das datas.</span></div>
    </div>
    <div className="daily-import-body">
      <div className="field-import-file">
        <input type="file" accept=".xlsx" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setDecisions({}); setResult(""); setStale(false); }} />
        <button type="button" className="secondary" disabled={!file || busy} onClick={runPreview}>{busy && !progress ? "Lendo..." : preview ? "Atualizar prévia" : "Ver prévia (não grava)"}</button>
      </div>
      {error && <div className="fleet-form-error">! {error}</div>}
      {result && <p className="stock-summary">{result}</p>}
      {progress && <div className="daily-import-progress"><span style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /><small>{progress.step}</small></div>}

      {preview && t && <>
        <h3>{preview.fileName} · exportação de {day(preview.exportDate)}</h3>
        <div className="field-import-summary">
          <span><b>{n(preview.counts.create)}</b> serão criados</span><span><b>{n(preview.counts.update)}</b> serão atualizados</span><span><b>{n(preview.counts.unchanged)}</b> sem mudança</span>
          <span><b>{n(preview.counts.errors)}</b> com erro</span><span><b>{n(byName.length)}</b> casamentos por nome</span><span><b>{n(preview.ignored.length)}</b> ignorados</span>
          <span><b>{n(preview.counts.cyclesNew)}</b> ciclos novos · {n(preview.counts.cyclesUpdated)} corrigidos</span><span><b>{n(preview.counts.absencesNew)}</b> afastamentos novos · {n(preview.counts.absencesUpdated)} atualizados</span>
          <span><b>{n(preview.counts.transfersNew)}</b> registros de frente</span><span><b>{n(preview.counts.dismissalsNew)}</b> desligamentos · {n(preview.counts.dismissalsUpdated)} atualizados</span>
        </div>

        <section><h3>Totais da exportação {sameExport ? "(conferência com 03/10/2026)" : `(arquivo de ${day(preview.exportDate)} — mais novo que 03/10/2026)`}</h3>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Item</th><th>No arquivo</th>{sameExport && <th>Esperado</th>}</tr></thead><tbody>
            {([
              ["Colaboradores", t.collaborators, EXPECTED.collaborators], ["Ativos", t.active, EXPECTED.active], ["Desligados", t.dismissed, EXPECTED.dismissed],
              ["Ciclos de folga", t.cycles, EXPECTED.cycles], ["Folgas no histórico", t.history, EXPECTED.history], ["… usufruídas", t.historyTaken, EXPECTED.historyTaken], ["… vendidas", t.historySold, EXPECTED.historySold],
              ["De folga", t.onLeave, EXPECTED.onLeave], ["Em viagem", t.traveling, EXPECTED.traveling], ["Pessoas na lista de restrição", t.restricted, EXPECTED.restricted],
            ] as Array<[string, number, number]>).map(([label, value, expected]) => <tr key={label} className={sameExport && value !== expected ? "warn" : ""}><td>{label}</td><td><strong>{n(value)}</strong></td>{sameExport && <td>{n(expected)}{value !== expected ? " ⚠" : " ✓"}</td>}</tr>)}
          </tbody></table></div></section>

        <section><h3>Por aba</h3>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Aba</th><th>Linhas</th><th>Usadas</th><th>Fora</th><th>Observação</th></tr></thead>
            <tbody>{preview.sheets.map((sheet) => <tr key={sheet.sheet}><td><strong>{sheet.sheet}</strong></td><td>{n(sheet.rows)}</td><td>{n(sheet.used)}</td><td>{n(sheet.ignored)}</td><td><small>{sheet.note}</small></td></tr>)}</tbody></table></div></section>

        {byName.length > 0 && <section><h3>Casamentos só pelo nome — confirme ({byName.length})</h3>
          <p className="table-sub">“Só pelo nome” já vem ligado ao cadastro existente; “Nome parecido” vem como novo até você escolher. Depois de mudar, clique em “Atualizar prévia”.</p>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Na exportação</th><th>Como casou</th><th>Cadastro do sistema</th></tr></thead>
            <tbody>{byName.map((person) => {
              const options = [...(person.employee ? [person.employee] : []), ...person.candidates.filter((item) => item.id !== person.employee?.id)];
              const value = decisions[person.externalId] ?? person.employeeId ?? "NOVO";
              return <tr key={person.externalId} className={person.how === "PARECIDO" ? "warn" : ""}>
                <td><strong>{person.name}</strong><small className="table-sub">ID {person.externalId} · {person.jobTitle} · {person.company} · {person.front}{person.active ? "" : " · desligado"}</small></td>
                <td><small>{HOW[person.how]}</small></td>
                <td><select value={String(value)} onChange={(event) => decide(person.externalId, event.target.value === "NOVO" ? "NOVO" : Number(event.target.value))}>
                  <option value="NOVO">Criar novo funcionário</option>
                  {options.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.front ?? "—"} · {item.company}{item.registration ? ` · mat. ${item.registration}` : ""}</option>)}
                </select></td>
              </tr>;
            })}</tbody></table></div>
          {stale && <p className="field-warning">Escolhas alteradas: clique em “Atualizar prévia” antes de confirmar.</p>}
        </section>}

        <label className="page-search"><span>⌕</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filtrar criados e atualizados por nome, frente, empresa ou função..." /></label>

        <details className="daily-import-details" open={updated.length <= 40}><summary>Atualizados ({updated.length}) — o que muda em cada campo</summary>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Funcionário</th><th>Casou por</th><th>Campos</th><th>Histórico</th></tr></thead>
            <tbody>{updated.map((person) => <tr key={person.externalId}>
              <td><strong>{person.name}</strong><small className="table-sub">ID {person.externalId} · {person.front} · {person.company}</small></td>
              <td><small>{HOW[person.how]}</small></td>
              <td><small>{person.changes.length ? person.changes.map((change) => `${change.label}: ${change.from ?? "—"} → ${change.to ?? "—"}`).join(" · ") : "—"}</small></td>
              <td><small>{[person.history.cycles && `${person.history.cycles} ciclo(s)`, person.history.absences && `${person.history.absences} afastamento(s)`, person.history.transfers && `${person.history.transfers} frente(s)`, person.history.dismissals && `${person.history.dismissals} desligamento(s)`].filter(Boolean).join(" · ") || "—"}</small></td>
            </tr>)}</tbody></table></div></details>

        <details className="daily-import-details"><summary>Criados ({created.length})</summary>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Funcionário</th><th>Função</th><th>Empresa</th><th>Frente</th><th>Situação na origem</th><th>Histórico</th></tr></thead>
            <tbody>{created.map((person) => <tr key={person.externalId}><td><strong>{person.name}</strong><small className="table-sub">ID {person.externalId}</small></td><td><small>{person.jobTitle}</small></td><td>{person.company}</td><td>{person.front}</td><td>{person.active ? "Ativo" : "Desligado"}</td>
              <td><small>{[person.history.cycles && `${person.history.cycles} ciclo(s)`, person.history.absences && `${person.history.absences} afastamento(s)`, person.history.transfers && `${person.history.transfers} frente(s)`, person.history.dismissals && `${person.history.dismissals} desligamento(s)`].filter(Boolean).join(" · ") || "—"}</small></td></tr>)}</tbody></table></div></details>

        {errors.length > 0 && <section><h3>Linhas com erro ({errors.length}) — não serão criadas</h3>
          <ul className="daily-import-list">{errors.map((person) => <li key={person.externalId}><span><strong>{person.name}</strong> · ID {person.externalId} · linha {person.row}</span><small>{person.errors.join(" · ")}</small></li>)}</ul></section>}

        <details className="daily-import-details"><summary>Ignorados ({preview.ignored.length}) e não vinculados ({preview.unlinked.length})</summary>
          <ul className="daily-import-list">{[...preview.ignored, ...preview.unlinked].map((item, index) => <li key={`${item.sheet}${item.row}${index}`}><span><strong>{item.name}</strong> · {item.sheet} linha {item.row}</span><small>{item.reason}</small></li>)}</ul></details>

        <details className="daily-import-details"><summary>Funções: {preview.functions.create.length} novas · {preview.functions.aliases.length} grafias unificadas · {preview.functions.markOperates.length} passam a operar equipamento</summary>
          {preview.functions.aliases.length > 0 && <><h4>Grafias unificadas (mesma função)</h4><ul className="daily-import-list">{preview.functions.aliases.map((item) => <li key={item.alias}><span>{item.alias} → <strong>{item.name}</strong></span></li>)}</ul></>}
          {preview.functions.create.length > 0 && <><h4>Funções novas</h4><ul className="daily-import-list daily-import-columns">{preview.functions.create.map((item) => <li key={item.name}>{item.name} ({item.people}){item.operates ? " · opera equipamento" : ""}</li>)}</ul></>}
          {preview.functions.markOperates.length > 0 && <><h4>Passam a “Opera equipamento”</h4><ul className="daily-import-list daily-import-columns">{preview.functions.markOperates.map((item) => <li key={item.id}>{item.name}</li>)}</ul></>}
          {preview.functions.looksAlike.length > 0 && <><h4>Parecem a mesma função (ficam separadas — confira)</h4><ul className="daily-import-list">{preview.functions.looksAlike.map((item) => <li key={item.functions.join("|")}>{item.functions.join(" × ")}</li>)}</ul></>}
          <p className="table-sub">Operador de motosserra não é marcado como “Opera equipamento”.</p>
        </details>

        {preview.companiesToCreate.length > 0 && <p className="table-sub">Empresas (vínculo) novas: {preview.companiesToCreate.join(", ")}.</p>}

        <details className="daily-import-details"><summary>Acessos de campo: {preview.fieldAccess.link.length} vínculos · {preview.fieldAccess.deactivate.length} desativados · {preview.fieldAccess.operatorsWithoutAccess.length} operadores ativos sem acesso</summary>
          {preview.fieldAccess.link.length > 0 && <><h4>Vincular ao acesso de campo já existente (mesmo nome)</h4><ul className="daily-import-list daily-import-columns">{preview.fieldAccess.link.map((item) => <li key={item.userId}>{item.name}</li>)}</ul></>}
          {preview.fieldAccess.deactivate.length > 0 && <><h4>Acesso de campo que será desativado</h4><ul className="daily-import-list">{preview.fieldAccess.deactivate.map((item) => <li key={item.name}><span>{item.name}</span><small>{item.reason}</small></li>)}</ul></>}
          {preview.fieldAccess.operatorsWithoutAccess.length > 0 && <><h4>Ativos que operam equipamento e não têm acesso (nenhum acesso é criado nesta etapa)</h4>
            <ul className="daily-import-list daily-import-columns">{preview.fieldAccess.operatorsWithoutAccess.map((item) => <li key={item.name}>{item.name} · {item.jobTitle} · {item.front}</li>)}</ul></>}
        </details>

        {(warned.length > 0 || preview.checks.length > 0) && <details className="daily-import-details"><summary>Avisos e conferências ({warned.length + preview.checks.length})</summary>
          <ul className="daily-import-list">
            {preview.checks.map((item) => <li key={item}><small>{item}</small></li>)}
            {warned.map((person) => <li key={person.externalId}><span><strong>{person.name}</strong></span><small>{[...person.warnings, ...person.history.kept].join(" · ")}</small></li>)}
          </ul></details>}

        <div className="daily-import-actions">
          <button type="button" className="secondary" disabled={busy} onClick={runPreview}>Atualizar prévia</button>
          <button type="button" className="primary" disabled={busy || stale || Boolean(runningBatch) || preview.counts.create + preview.counts.update === 0} onClick={confirm}>
            {busy && progress ? "IMPORTANDO..." : stale ? "ATUALIZE A PRÉVIA" : runningBatch ? `LOTE ${runningBatch.id} EM ANDAMENTO` : `CONFIRMAR IMPORTAÇÃO (${n(preview.counts.create)} novos · ${n(preview.counts.update)} atualizados)`}</button>
        </div>
      </>}

      {batches.length > 0 && <section><h3>Importações</h3>
        <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Lote</th><th>Arquivo</th><th>Situação</th><th>Gravado</th><th>Por</th><th></th></tr></thead>
          <tbody>{batches.map((batch) => <tr key={batch.id}>
            <td><strong>#{batch.id}</strong><small className="table-sub">{day(batch.createdAt)} · exportação de {day(batch.exportDate)}</small></td><td><small>{batch.fileName}</small></td>
            <td><span className={`status-pill ${batch.status === "CONCLUIDO" ? "green" : batch.status === "DESFEITO" ? "gray" : "orange"}`}>{STATUS[batch.status]}</span></td>
            <td><small>{batch.summary ? Object.entries(batch.summary).map(([item, total]) => { const [table, action] = item.split("."); return `${total} ${TABLE_LABEL[table] ?? table} ${action === "INSERT" ? "criados" : "alterados"}`; }).join(" · ") : "—"}</small></td>
            <td><small>{batch.importedBy}</small></td>
            <td><div className="equipment-row-actions">{batch.status !== "DESFEITO" && <button type="button" disabled={busy} onClick={() => undo(batch)}>Desfazer importação</button>}</div></td>
          </tr>)}</tbody></table></div></section>}
    </div>
  </article>;
}
