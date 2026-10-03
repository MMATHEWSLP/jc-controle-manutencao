"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Controle Diário → Importar planilha (só ADMIN). Prévia sem gravar (equipamentos a decidir,
// "Conferir", diesel não lançado, operadores sem cadastro, problemas → Pendência), depois
// "Confirmar importação": grava em blocos de 500 com barra de progresso, finaliza (leituras dos
// equipamentos, ciclos e alertas) e permite "Desfazer importação".
// ---------------------------------------------------------------------------
type Grupo = {
  chave: string; codigo: string; escala: "A" | "B" | null; linhas: number; operadores: string[]; primeira: number; ultima: number; datas: [string, string];
  situacao: "OK" | "CASADO_PELO_PREFIXO" | "DECIDIR"; motivo: string | null; equipmentId: number | null; sugestaoId: number | null; escolhido: boolean;
};
type Linha = {
  linha: number; data: string; prefixo: string; codigoPlanilha: string; frente: string; operadorNome: string | null; operadorId: number | null; semOperador: boolean;
  inicial: number | null; final: number | null; trabalhado: number | null; diesel: number | null; dieselPlanilha: number; dieselNota: string | null; problema: string | null;
  criarPendencia: boolean; conferir: string | null; aviso: string | null; local: string | null;
};
type Previa = {
  label: string; periodo: { de: string; ate: string }; grupos: Grupo[]; plano: Linha[]; ignoradas: Array<{ linha: number; motivo: string }>;
  naoImportadas: Array<{ linha: number; data: string | null; codigo: string; motivo: string }>;
  leituras: Array<{ equipmentId: number; prefixo: string; unidade: "HOURS" | "KM"; atual: number; importada: number | null; data: string | null; sobe: boolean; historicoMaisNovo: string | null }>;
  semCadastro: Array<{ nome: string; lancamentos: number; parecidos: Array<{ id: number; nome: string; semelhanca: string }> }>;
  equipamentosCadastro: Array<{ id: number; prefix: string; model: string; front: string | null; atual: number; unidade: "HOURS" | "KM" }>;
  resumo: {
    planilha: { linhas: number; viagens: number; volumePorto: number; toras: number; diesel: number }; importar: number; conferir: number; avisos: number; ignoradas: number; naoImportadas: number; decidir: number;
    viagens: number; volumePorto: number; dieselInformado: number; dieselNaoLancado: number; semOperador: number; operadoresVinculados: number; operadoresSemCadastro: number;
    problemas: number; pendencias: number; leiturasQueSobem: number; porFrente: Array<{ nome: string; total: number }>;
  };
};
type Lote = { id: number; label: string; fileName: string; status: "EM_ANDAMENTO" | "CONCLUIDO" | "DESFEITO"; totalRows: number; importedRows: number; skippedRows: number; reviewRows: number; createdAt: string; finishedAt: string | null; undoneAt: string | null; importedBy: string; planSize: number; blocos: number };

async function chamar<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}
const n = (valor: number | null | undefined, casas = 2) => (valor === null || valor === undefined ? "—" : valor.toLocaleString("pt-BR", { maximumFractionDigits: casas }));
const dia = (valor: string | null) => (valor ? valor.split("-").reverse().join("/") : "—");
const STATUS: Record<Lote["status"], string> = { EM_ANDAMENTO: "Em andamento", CONCLUIDO: "Concluído", DESFEITO: "Desfeito" };

export default function DailyImportPanel({ flash }: { flash: (message: string) => void }) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [equipamentos, setEquipamentos] = useState<Record<string, number | null>>({});
  const [problemas, setProblemas] = useState<number[]>([]);
  const [aplicado, setAplicado] = useState("");
  const [lotes, setLotes] = useState<Lote[]>([]);
  const [progresso, setProgresso] = useState<{ feitos: number; total: number; etapa: string } | null>(null);
  const [resultado, setResultado] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const carregarLotes = useCallback(() => { chamar<{ lotes: Lote[] }>("/api/daily-records/import").then((data) => setLotes(data.lotes)).catch(() => undefined); }, []);
  useEffect(() => { carregarLotes(); }, [carregarLotes]);
  const ajustes = useMemo(() => JSON.stringify({ equipamentos, problemas }), [equipamentos, problemas]);
  // Só as escolhas de equipamento mudam a conferência das leituras; marcar problemas não exige nova prévia.
  const desatualizada = Boolean(previa) && JSON.stringify(equipamentos) !== aplicado;

  async function verPrevia(base?: Record<string, number | null>) {
    if (!arquivo) return;
    setBusy(true); setError(""); setResultado("");
    const escolhas = base ?? equipamentos;
    const corpo = JSON.stringify({ equipamentos: escolhas, problemas });
    const form = new FormData(); form.set("arquivo", arquivo); form.set("ajustes", corpo); form.set("acao", "previa");
    try {
      const data = await chamar<Previa>("/api/daily-records/import", { method: "POST", body: form });
      // Primeira prévia: já preenche as decisões com a sugestão (a pessoa confere e aplica).
      const sugestoes = Object.fromEntries(data.grupos.filter((grupo) => grupo.situacao === "DECIDIR" && !(grupo.chave in escolhas)).map((grupo) => [grupo.chave, grupo.sugestaoId]));
      setPrevia(data); setEquipamentos({ ...escolhas, ...sugestoes }); setAplicado(JSON.stringify(escolhas));
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Falha na prévia."); }
    finally { setBusy(false); }
  }

  async function gravar(loteId: number, blocos: number, inicio = 0) {
    for (let bloco = inicio; bloco < blocos; bloco++) {
      setProgresso({ feitos: bloco, total: blocos, etapa: `Gravando bloco ${bloco + 1} de ${blocos}...` });
      await chamar(`/api/daily-records/import/${loteId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acao: "bloco", bloco }) });
    }
    setProgresso({ feitos: blocos, total: blocos, etapa: "Atualizando leituras, ciclos de troca de óleo e alertas..." });
    const fim = await chamar<{ registros: number; conferir: number; leiturasAtualizadas: Array<{ prefixo: string }> }>(`/api/daily-records/import/${loteId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acao: "finalizar" }) });
    const texto = `Importação concluída: ${n(fim.registros, 0)} registro(s), ${n(fim.conferir, 0)} para conferir, leitura atualizada em ${fim.leiturasAtualizadas.length} equipamento(s).`;
    setResultado(texto); flash(texto);
  }

  async function confirmar() {
    if (!arquivo || !previa) return;
    if (!window.confirm(`Gravar ${n(previa.resumo.importar, 0)} registro(s) do Controle Diário (${previa.label})? Dá para desfazer depois.`)) return;
    setBusy(true); setError("");
    try {
      const form = new FormData(); form.set("arquivo", arquivo); form.set("ajustes", ajustes); form.set("acao", "iniciar");
      const lote = await chamar<{ loteId: number; blocos: number }>("/api/daily-records/import", { method: "POST", body: form });
      await gravar(lote.loteId, lote.blocos);
      setPrevia(null); setArquivo(null);
    } catch (problem) { setError(`${problem instanceof Error ? problem.message : "Falha ao gravar."} Use "Continuar" na lista de importações para terminar.`); }
    finally { setBusy(false); setProgresso(null); carregarLotes(); }
  }

  async function continuar(lote: Lote) {
    setBusy(true); setError("");
    try { await gravar(lote.id, lote.blocos, Math.floor(lote.importedRows / 500)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao continuar."); }
    finally { setBusy(false); setProgresso(null); carregarLotes(); }
  }

  async function desfazer(lote: Lote) {
    if (!window.confirm(`Desfazer a importação ${lote.label} (lote ${lote.id})? Os registros, as leituras e as pendências do lote serão apagados e a leitura dos equipamentos volta ao que era.`)) return;
    setBusy(true); setError("");
    try { const r = await chamar<{ devolvidas: string[] }>(`/api/daily-records/import/${lote.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acao: "desfazer" }) }); flash(`Importação desfeita. Leitura devolvida em ${r.devolvidas.length} equipamento(s).`); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao desfazer."); }
    finally { setBusy(false); carregarLotes(); }
  }

  const r = previa?.resumo;
  const decidir = previa?.grupos.filter((grupo) => grupo.situacao !== "OK" || grupo.escolhido) ?? [];
  const conferir = previa?.plano.filter((linha) => linha.conferir) ?? [];
  const avisos = previa?.plano.filter((linha) => linha.aviso) ?? [];
  const dieselFora = previa?.plano.filter((linha) => linha.dieselNota) ?? [];
  const comProblema = previa?.plano.filter((linha) => linha.problema) ?? [];
  const pendentesDecisao = previa ? previa.grupos.filter((grupo) => grupo.situacao === "DECIDIR" && !(grupo.chave in equipamentos)).length : 0;

  return <article className="panel module-panel daily-import">
    <div className="daily-operators-head">
      <div><strong>Importar planilha do Controle Diário</strong><span>Aba “Importar” com as colunas do modelo. A prévia não grava nada; os registros entram ligados aos cadastros e aparecem no Histórico com a etiqueta “Importado”. O diesel informado NÃO vira saída de combustível.</span></div>
      <div className="daily-operators-actions"><a className="secondary daily-import-link" href={"/api/daily-records/import/modelo"}>Baixar modelo</a></div>
    </div>
    <div className="daily-import-body">
      <div className="field-import-file">
        <input type="file" accept=".xlsx" onChange={(event) => { setArquivo(event.target.files?.[0] ?? null); setPrevia(null); setEquipamentos({}); setProblemas([]); setResultado(""); }} />
        <button type="button" className="secondary" disabled={!arquivo || busy} onClick={() => verPrevia()}>{busy && !progresso ? "Lendo..." : previa ? "Atualizar prévia" : "Ver prévia (não grava)"}</button>
      </div>
      {error && <div className="fleet-form-error">! {error}</div>}
      {resultado && <p className="stock-summary">{resultado}</p>}
      {progresso && <div className="daily-import-progress"><span style={{ width: `${Math.round((progresso.feitos / Math.max(1, progresso.total)) * 100)}%` }} /><small>{progresso.etapa}</small></div>}

      {previa && r && <>
        <h3>{previa.label} · {dia(previa.periodo.de)} a {dia(previa.periodo.ate)}</h3>
        <div className="field-import-summary">
          <span><b>{n(r.planilha.linhas, 0)}</b> linhas na planilha</span><span><b>{n(r.importar, 0)}</b> serão importadas</span><span><b>{n(r.conferir, 0)}</b> para conferir</span>
          <span><b>{n(r.ignoradas + r.naoImportadas, 0)}</b> fora</span><span><b>{n(r.viagens, 0)}</b> viagens</span><span><b>{n(r.volumePorto)}</b> m³ no porto</span>
          <span><b>{n(r.dieselInformado, 0)}</b> L diesel informado</span><span><b>{r.dieselNaoLancado}</b> diesel acima de 600 L (não lançado)</span>
          <span><b>{r.semOperador}</b> sem operador</span><span><b>{r.operadoresSemCadastro}</b> operadores sem cadastro</span><span><b>{r.leiturasQueSobem}</b> equipamentos com leitura nova</span>
        </div>
        <p className="table-sub">Planilha: {n(r.planilha.viagens, 0)} viagens · {n(r.planilha.volumePorto)} m³ · {n(r.planilha.diesel, 0)} L de diesel. Por frente: {r.porFrente.map((item) => `${item.nome} ${item.total}`).join(" · ")}.</p>

        {decidir.length > 0 && <section><h3>Equipamentos ({decidir.length} para conferir/decidir)</h3>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Na planilha</th><th>Linhas</th><th>Leituras</th><th>Operadores</th><th>Situação</th><th>Equipamento do cadastro</th></tr></thead>
            <tbody>{decidir.map((grupo) => <tr key={grupo.chave} className={grupo.situacao === "DECIDIR" && !(grupo.chave in equipamentos) ? "warn" : ""}>
              <td><strong>{grupo.codigo}</strong>{grupo.escala && <small className="table-sub">escala {grupo.escala === "A" ? "menor" : "maior"}</small>}</td>
              <td>{grupo.linhas}<small className="table-sub">{dia(grupo.datas[0])} a {dia(grupo.datas[1])}</small></td>
              <td>{n(grupo.primeira)} → {n(grupo.ultima)}</td><td><small>{grupo.operadores.join(", ")}</small></td>
              <td><small>{grupo.motivo ?? "Ok"}</small></td>
              <td><select value={grupo.chave in equipamentos ? String(equipamentos[grupo.chave] ?? "") : String(grupo.equipmentId ?? "")} onChange={(event) => setEquipamentos({ ...equipamentos, [grupo.chave]: event.target.value ? Number(event.target.value) : null })}>
                <option value="">Não importar</option>
                {previa.equipamentosCadastro.map((item) => <option key={item.id} value={item.id}>{item.prefix} · {item.model} · {n(item.atual)} {item.unidade === "KM" ? "km" : "h"}{item.id === grupo.sugestaoId ? " (sugerido)" : ""}</option>)}
              </select></td>
            </tr>)}</tbody></table></div>
          {(desatualizada || pendentesDecisao > 0) && <p className="field-warning">Escolhas alteradas: clique em “Atualizar prévia” para conferir as leituras com o equipamento escolhido.</p>}
        </section>}

        {conferir.length > 0 && <section><h3>Conferir ({conferir.length}) — entram com status “Conferir” e não mudam a leitura do equipamento</h3>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Linha</th><th>Data</th><th>Equip.</th><th>Inicial → Final</th><th>Operador</th><th>Motivo</th></tr></thead>
            <tbody>{conferir.map((linha) => <tr key={linha.linha}><td>{linha.linha}</td><td>{dia(linha.data)}</td><td>{linha.prefixo}</td><td>{n(linha.inicial)} → {n(linha.final)}</td><td>{linha.operadorNome ?? "Sem operador"}</td><td><small>{linha.conferir}</small></td></tr>)}</tbody></table></div></section>}

        {avisos.length > 0 && <section><h3>Mesmo dia ({avisos.length}) — importados separados</h3><ul className="daily-import-list">{avisos.map((linha) => <li key={linha.linha}>Linha {linha.linha} · {dia(linha.data)} · {linha.prefixo} · {n(linha.inicial)} → {n(linha.final)} — {linha.aviso}</li>)}</ul></section>}

        {dieselFora.length > 0 && <section><h3>Diesel acima de 600 L ({dieselFora.length}) — não lançado</h3><ul className="daily-import-list">{dieselFora.map((linha) => <li key={linha.linha}>Linha {linha.linha} · {dia(linha.data)} · {linha.prefixo}: {linha.dieselNota}{linha.diesel !== null ? ` → ${n(linha.diesel)} L` : ""}</li>)}</ul></section>}

        {previa.semCadastro.length > 0 && <section><h3>Operadores sem cadastro de campo ({previa.semCadastro.length}) — entram com o nome; vincule um a um no Histórico</h3>
          <ul className="daily-import-list daily-import-columns">{previa.semCadastro.map((item) => <li key={item.nome}>{item.nome} <small>({item.lancamentos} lanç.{item.parecidos.length ? ` · parecido: ${item.parecidos.map((p) => p.nome).join(", ")}` : ""})</small></li>)}</ul></section>}

        {comProblema.length > 0 && <section><h3>Problemas relatados ({comProblema.length}) — marque os que viram Pendência</h3>
          <label className="field-add-check"><input type="checkbox" checked={problemas.length === comProblema.length} onChange={(event) => setProblemas(event.target.checked ? comProblema.map((linha) => linha.linha) : [])} /> Marcar todos</label>
          {comProblema.map((linha) => <label key={linha.linha} className="field-add-check daily-import-problem"><input type="checkbox" checked={problemas.includes(linha.linha)} onChange={() => setProblemas(problemas.includes(linha.linha) ? problemas.filter((item) => item !== linha.linha) : [...problemas, linha.linha])} />
            <span><b>{dia(linha.data)} · {linha.prefixo}</b> · {linha.frente} · {linha.operadorNome ?? "Sem operador"}: {linha.problema}</span></label>)}</section>}

        <details className="daily-import-details"><summary>Leituras dos equipamentos ({r.leiturasQueSobem} sobem)</summary>
          <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Equip.</th><th>Atual</th><th>Última importada</th><th>Data</th><th>Resultado</th></tr></thead>
            <tbody>{previa.leituras.map((item) => <tr key={item.equipmentId}><td>{item.prefixo}</td><td>{n(item.atual)}</td><td>{n(item.importada)}</td><td>{dia(item.data)}</td><td><small>{item.sobe ? "Atualiza" : item.historicoMaisNovo ? `Mantém (há leitura de ${dia(item.historicoMaisNovo)})` : "Mantém (atual é maior ou igual)"}</small></td></tr>)}</tbody></table></div></details>

        {(previa.ignoradas.length > 0 || previa.naoImportadas.length > 0) && <details className="daily-import-details"><summary>Fora da importação ({previa.ignoradas.length + previa.naoImportadas.length})</summary>
          <ul className="daily-import-list">{previa.naoImportadas.map((item) => <li key={`n${item.linha}`}>Linha {item.linha} · {dia(item.data)} · {item.codigo}: {item.motivo}</li>)}{previa.ignoradas.map((item) => <li key={`i${item.linha}`}>Linha {item.linha}: {item.motivo}</li>)}</ul></details>}

        <div className="daily-import-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => verPrevia()}>Atualizar prévia</button>
          <button type="button" className="primary" disabled={busy || desatualizada || pendentesDecisao > 0 || r.decidir > 0 || !r.importar} onClick={confirmar}>
            {busy && progresso ? "IMPORTANDO..." : desatualizada || pendentesDecisao > 0 || r.decidir > 0 ? "ATUALIZE A PRÉVIA" : `CONFIRMAR IMPORTAÇÃO (${n(r.importar, 0)})`}</button>
        </div>
      </>}

      {lotes.length > 0 && <section><h3>Importações</h3>
        <div className="table-scroll"><table className="daily-import-table"><thead><tr><th>Lote</th><th>Arquivo</th><th>Situação</th><th>Registros</th><th>Por</th><th></th></tr></thead>
          <tbody>{lotes.map((lote) => <tr key={lote.id}><td><strong>{lote.label}</strong><small className="table-sub">#{lote.id} · {dia(lote.createdAt.slice(0, 10))}</small></td><td><small>{lote.fileName}</small></td>
            <td><span className={`status-pill ${lote.status === "CONCLUIDO" ? "green" : lote.status === "DESFEITO" ? "gray" : "orange"}`}>{STATUS[lote.status]}</span></td>
            <td>{n(lote.importedRows, 0)} de {n(lote.planSize, 0)}<small className="table-sub">{lote.reviewRows} conferir · {lote.skippedRows} fora</small></td><td><small>{lote.importedBy}</small></td>
            <td><div className="equipment-row-actions">{lote.status === "EM_ANDAMENTO" && <button type="button" disabled={busy} onClick={() => continuar(lote)}>Continuar</button>}
              {lote.status !== "DESFEITO" && <button type="button" disabled={busy} onClick={() => desfazer(lote)}>Desfazer importação</button>}</div></td></tr>)}</tbody></table></div></section>}
    </div>
  </article>;
}
