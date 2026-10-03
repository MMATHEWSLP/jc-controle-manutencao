"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatHistoryDay, formatWorked, historyFiltersToParams, historyStatusTags, parseHistoryFilters, parseHistoryPage, type DailyHistoryFilters,
} from "../lib/daily-history-rules";

// Histórico de Registros Diários: lista compacta (uma linha por registro) com filtros combinados
// (AND), aplicados assim que mudam, guardados na URL e exportáveis em PDF/Excel exatamente como
// estão na tela. Filtros, ordenação e cálculo de trabalhado vêm de lib/daily-history-rules.ts.

type Front = { id:number; name:string };
type HistoryRow = {
  id:number; recordDate:string; prefix:string; equipmentModel:string; operator:string; launchedBy:string; manualEntry:boolean; front:string|null; location:string|null;
  readingUnit:"HOURS"|"KM"; worked:number|null; workedToday:boolean; inactiveOrProblem:boolean; hadProduction:boolean; productionType:"BALDEIO"|"PORTO"|null;
  noWorkReason:string|null; problemReason:string|null; canEdit:boolean;
  imported:boolean; reviewStatus:"OK"|"CONFERIR"; reviewReason:string|null; fieldOperatorId:number|null; noOperator:boolean; operatorName:string|null;
  startReading:number|null; endReading:number|null; origin:string; dieselNote:string|null;
};
type FieldOption = { id:number; name:string; active:boolean };
type HistoryResult = { rows:HistoryRow[]; total:number; page:number; pages:number; pageSize:number };

// Marca a URL como "tela do Histórico" (app/page.tsx abre o Controle Diário direto nela ao recarregar).
export const HISTORY_SCREEN_PARAM = "tela";
export const HISTORY_SCREEN_VALUE = "historico-diario";
export function isHistoryUrl() { return typeof window !== "undefined" && new URLSearchParams(window.location.search).get(HISTORY_SCREEN_PARAM) === HISTORY_SCREEN_VALUE; }
export function clearHistoryUrl() { if (isHistoryUrl()) window.history.replaceState(window.history.state, "", window.location.pathname); }

const emptyFilters:DailyHistoryFilters = { q:"", from:"", to:"", frontId:null, operators:[], location:"", origin:"", review:false };
function readUrl() { const params=new URLSearchParams(window.location.search); return { filters:parseHistoryFilters(params), page:parseHistoryPage(params) }; }

async function api<T>(url:string):Promise<T> { const response=await fetch(url,{ cache:"no-store" }); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }

// defaultFrontId = frente do seletor global do topo: vira o filtro padrão quando o link não traz outro.
export default function DailyHistoryPanel({ fronts, onEdit, defaultFrontId=null }:{ fronts:Front[]; onEdit:(recordId:number)=>Promise<void>; defaultFrontId?:number|null }) {
  const [initial]=useState(()=>{ const value=typeof window==="undefined"?{ filters:emptyFilters, page:1 }:readUrl(); return value.filters.frontId||!defaultFrontId||!fronts.some((front)=>front.id===defaultFrontId)?value:{ ...value, filters:{ ...value.filters, frontId:defaultFrontId } }; });
  const [filters,setFilters]=useState<DailyHistoryFilters>(initial.filters);
  const [page,setPage]=useState(initial.page);
  // Texto digitado na lupa: aplicado com um pequeno atraso para não consultar a cada tecla.
  const [queryInput,setQueryInput]=useState(initial.filters.q);
  const [locationInput,setLocationInput]=useState(initial.filters.location??"");
  const [fixing,setFixing]=useState<HistoryRow|null>(null);
  const [notice,setNotice]=useState("");
  const [operators,setOperators]=useState<string[]>([]);
  const [result,setResult]=useState<HistoryResult|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [opening,setOpening]=useState<number|null>(null);
  const [exporting,setExporting]=useState<"pdf"|"xlsx"|null>(null);
  const [exportError,setExportError]=useState("");

  const change=useCallback((changes:Partial<DailyHistoryFilters>)=>{ setFilters((current)=>({ ...current, ...changes })); setPage(1); },[]);
  useEffect(()=>{ const q=queryInput.trim(); if(q===filters.q)return; const timer=window.setTimeout(()=>change({ q }),350); return ()=>window.clearTimeout(timer); },[queryInput,filters.q,change]);
  useEffect(()=>{ const location=locationInput.trim(); if(location===(filters.location??""))return; const timer=window.setTimeout(()=>change({ location }),350); return ()=>window.clearTimeout(timer); },[locationInput,filters.location,change]);

  const query=useMemo(()=>historyFiltersToParams(filters,page).toString(),[filters,page]);
  // Filtros na URL: recarregar ou compartilhar o link abre a mesma busca.
  useEffect(()=>{ const params=new URLSearchParams(query); params.set(HISTORY_SCREEN_PARAM,HISTORY_SCREEN_VALUE); window.history.replaceState(window.history.state,"",`${window.location.pathname}?${params.toString()}`); },[query]);

  const requestId=useRef(0);
  const load=useCallback(async()=>{
    const id=++requestId.current; setLoading(true); setError("");
    try { const data=await api<HistoryResult>(`/api/daily-records/history?${query}`); if(id!==requestId.current)return; setResult(data); if(data.page!==page)setPage(data.page); }
    catch(problem) { if(id===requestId.current)setError(problem instanceof Error?problem.message:"Falha ao carregar o histórico."); }
    finally { if(id===requestId.current)setLoading(false); }
  },[query,page]);
  useEffect(()=>{ load(); },[load]);
  useEffect(()=>{ api<{operators:string[]}>("/api/daily-records/history/operators").then((data)=>setOperators(data.operators)).catch(()=>setOperators([])); },[]);

  async function exportFile(format:"pdf"|"xlsx") {
    setExporting(format); setExportError("");
    try {
      const params=historyFiltersToParams(filters); params.set("formato",format);
      const response=await fetch(`/api/daily-records/history/export?${params.toString()}`,{ cache:"no-store" });
      if(!response.ok){ const data=await response.json().catch(()=>({})) as { error?:string }; throw new Error(data.error??"Não foi possível gerar a exportação."); }
      const blob=await response.blob();
      const filename=/filename="([^"]+)"/.exec(response.headers.get("content-disposition")??"")?.[1]??`historico-registros-diarios.${format}`;
      const url=URL.createObjectURL(blob); const link=document.createElement("a"); link.href=url; link.download=filename; link.click(); URL.revokeObjectURL(url);
    } catch(problem) { setExportError(problem instanceof Error?problem.message:"Não foi possível gerar a exportação."); }
    finally { setExporting(null); }
  }

  async function edit(row:HistoryRow) {
    setOpening(row.id);
    try { await onEdit(row.id); } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível abrir o registro."); } finally { setOpening(null); }
  }

  const active=Boolean(filters.q||filters.from||filters.to||filters.frontId||filters.operators.length||filters.location||filters.origin||filters.review);
  const total=result?.total??0;
  return <article className="panel module-panel daily-history">
    <div className="daily-history-filters">
      <label className="daily-history-search"><span aria-hidden="true">⌕</span><input type="search" value={queryInput} onChange={(event)=>setQueryInput(event.target.value)} placeholder="Buscar por equipamento ou operador" aria-label="Buscar por equipamento ou operador" autoComplete="off" enterKeyHint="search"/></label>
      <fieldset className="daily-history-period"><legend>Filtrar por Período</legend>
        <input type="date" value={filters.from} max={filters.to||undefined} onChange={(event)=>change({ from:event.target.value })} aria-label="Data inicial"/>
        <span aria-hidden="true">até</span>
        <input type="date" value={filters.to} min={filters.from||undefined} onChange={(event)=>change({ to:event.target.value })} aria-label="Data final"/>
      </fieldset>
      <label className="daily-history-select">Filtrar por Frente de Serviço<select value={filters.frontId??""} onChange={(event)=>change({ frontId:event.target.value?Number(event.target.value):null })}><option value="">Todas as frentes</option>{fronts.map((front)=><option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
      <OperatorMultiSelect options={operators} selected={filters.operators} onChange={(values)=>change({ operators:values })}/>
      <label className="daily-history-select">Filtrar por Local<input type="search" value={locationInput} onChange={(event)=>setLocationInput(event.target.value)} placeholder="Ex.: Concessão" autoComplete="off"/></label>
      <label className="daily-history-select">Origem<select value={filters.origin??""} onChange={(event)=>change({ origin:event.target.value as DailyHistoryFilters["origin"] })}><option value="">Todos</option><option value="APP">Feitos no app</option><option value="IMPORTADO">Importados</option></select></label>
      <label className="daily-history-check"><input type="checkbox" checked={Boolean(filters.review)} onChange={(event)=>change({ review:event.target.checked })}/>Só “Conferir”</label>
    </div>

    <div className="daily-history-toolbar">
      <span>{loading&&!result?"Carregando...":`${total.toLocaleString("pt-BR")} registro(s)`}{active && <button type="button" className="daily-history-clear" onClick={()=>{ setQueryInput(""); setLocationInput(""); setFilters(emptyFilters); setPage(1); }}>Limpar filtros</button>}</span>
      <div>
        <button type="button" className="secondary" disabled={total===0||exporting!==null} onClick={()=>exportFile("pdf")} title={total===0?"Nenhum registro para exportar":"Exportar a lista filtrada em PDF"}>{exporting==="pdf"?"Gerando...":"PDF"}</button>
        <button type="button" className="secondary" disabled={total===0||exporting!==null} onClick={()=>exportFile("xlsx")} title={total===0?"Nenhum registro para exportar":"Exportar a lista filtrada em Excel"}>{exporting==="xlsx"?"Gerando...":"Excel"}</button>
      </div>
    </div>
    {exportError && <div className="fleet-form-error">! {exportError}</div>}
    {error && <div className="fleet-form-error">! {error}</div>}
    {notice && <div className="daily-form-success">{notice}</div>}

    <div className={`daily-history-list ${loading&&result?"is-loading":""}`}>
      {loading&&!result ? <div className="page-loading"><span/><p>Carregando registros...</p></div> : <>
        {result && result.rows.length>0 && <div className="daily-history-head" aria-hidden="true"><span>Data</span><span>Equipamento</span><span>Operador</span><span>Frente</span><span>Horas/KM trab.</span><span>Status</span><span/></div>}
        {result?.rows.map((row)=><HistoryItem key={row.id} row={row} opening={opening===row.id} onEdit={()=>edit(row)} onFix={()=>{ setNotice(""); setFixing(row); }}/>)}
        {result && result.rows.length===0 && <div className="empty-state">{active?"Nenhum registro encontrado para os filtros selecionados.":"Nenhum registro lançado ainda."}</div>}
      </>}
    </div>

    {result && result.pages>1 && <nav className="daily-history-pages" aria-label="Paginação do histórico">
      <button type="button" className="secondary" disabled={page<=1||loading} onClick={()=>setPage(page-1)}>‹ Anterior</button>
      <span>Página {result.page} de {result.pages}</span>
      <button type="button" className="secondary" disabled={page>=result.pages||loading} onClick={()=>setPage(page+1)}>Próxima ›</button>
    </nav>}
    {fixing && <FixImportedDialog row={fixing} onClose={()=>setFixing(null)} onSaved={(message)=>{ setFixing(null); setNotice(message); load(); api<{operators:string[]}>("/api/daily-records/history/operators").then((data)=>setOperators(data.operators)).catch(()=>undefined); }}/>}
  </article>;
}

function HistoryItem({ row, opening, onEdit, onFix }:{ row:HistoryRow; opening:boolean; onEdit:()=>void; onFix:()=>void }) {
  const tags=historyStatusTags(row);
  const unlinked=row.imported&&!row.noOperator&&!row.fieldOperatorId&&Boolean(row.operatorName);
  const tone=!row.workedToday?"off":row.inactiveOrProblem?"warn":"ok";
  const detail=!row.workedToday?row.noWorkReason:row.inactiveOrProblem?row.problemReason:null;
  return <div className={`daily-history-row ${tone}`}>
    <span className="dh-date">{formatHistoryDay(row.recordDate)}</span>
    <span className="dh-equipment"><strong>{row.prefix}</strong>{row.equipmentModel && <small>{row.equipmentModel}</small>}</span>
    <span className="dh-operator"><b>{row.operator}</b>{unlinked && <em className="daily-manual-tag warn" title="Operador não encontrado no cadastro: use “Corrigir” para vincular">Sem cadastro</em>}{row.manualEntry && !row.imported && <em className="daily-manual-tag" title={`Lançado pela conta ${row.launchedBy}`}>Lançamento manual</em>}</span>
    <span className="dh-front">{row.front??"Sem frente"}{row.location && <small>{row.location}</small>}</span>
    <span className="dh-worked">{formatWorked(row.worked,row.readingUnit)}</span>
    <span className="dh-status" title={[detail,row.reviewStatus==="CONFERIR"?row.reviewReason:null,row.dieselNote].filter(Boolean).join(" · ")||undefined}>{tags.map((tag)=><i key={tag.key} className={`status-pill ${tag.tone}`}>{tag.label}</i>)}</span>
    <span className="dh-actions">{row.canEdit && row.imported ? <button type="button" className="daily-history-edit" onClick={onFix} aria-label={`Corrigir registro importado de ${row.prefix} em ${formatHistoryDay(row.recordDate)}`} title="Corrigir operador e leituras">✎</button> : row.canEdit && <button type="button" className="daily-history-edit" onClick={onEdit} disabled={opening} aria-label={`Editar registro de ${row.prefix} em ${formatHistoryDay(row.recordDate)}`} title="Editar registro">{opening?"…":"✎"}</button>}</span>
  </div>;
}

// Multi-select com busca: chips dos escolhidos + lista com caixas de seleção.
function OperatorMultiSelect({ options, selected, onChange }:{ options:string[]; selected:string[]; onChange:(values:string[])=>void }) {
  const [open,setOpen]=useState(false);
  const [search,setSearch]=useState("");
  const box=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!open)return;
    const close=(event:MouseEvent)=>{ if(box.current&&!box.current.contains(event.target as Node))setOpen(false); };
    const escape=(event:KeyboardEvent)=>{ if(event.key==="Escape")setOpen(false); };
    document.addEventListener("mousedown",close); document.addEventListener("keydown",escape);
    return ()=>{ document.removeEventListener("mousedown",close); document.removeEventListener("keydown",escape); };
  },[open]);
  const key=(value:string)=>value.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
  const isSelected=(name:string)=>selected.some((item)=>item.toLowerCase()===name.toLowerCase());
  // Nomes vindos da URL que não estão mais na lista continuam visíveis (e removíveis).
  const all=useMemo(()=>[...options,...selected.filter((name)=>!options.some((option)=>option.toLowerCase()===name.toLowerCase()))],[options,selected]);
  const visible=all.filter((name)=>key(name).includes(key(search.trim())));
  const toggle=(name:string)=>onChange(isSelected(name)?selected.filter((item)=>item.toLowerCase()!==name.toLowerCase()):[...selected,name]);
  const label=selected.length===0?"Todos os colaboradores":selected.length===1?selected[0]:`${selected.length} colaboradores`;
  return <div className="daily-history-multi" ref={box}>
    <span>Filtrar por Colaborador</span>
    <button type="button" className={`daily-history-multi-trigger ${selected.length?"has-value":""}`} aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen((value)=>!value)}><strong>{label}</strong><b aria-hidden="true">⌄</b></button>
    {open && <div className="daily-history-multi-menu">
      <input autoFocus type="search" value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Buscar colaborador" aria-label="Buscar colaborador"/>
      <ul role="listbox" aria-multiselectable="true">
        {visible.map((name)=><li key={name}><label><input type="checkbox" checked={isSelected(name)} onChange={()=>toggle(name)}/>{name}</label></li>)}
        {visible.length===0 && <li className="daily-picker-empty">Nenhum colaborador encontrado.</li>}
      </ul>
      {selected.length>0 && <button type="button" className="daily-history-clear" onClick={()=>onChange([])}>Limpar seleção</button>}
    </div>}
    {selected.length>0 && <div className="daily-history-chips">{selected.map((name)=><button type="button" key={name} onClick={()=>toggle(name)} aria-label={`Remover ${name}`}>{name} <span aria-hidden="true">×</span></button>)}</div>}
  </div>;
}

// Corrigir registro importado: operador um a um (vincular ao funcionário de campo, manter o nome
// digitado ou "Sem operador"), leituras e "Conferir". O formulário completo não serve aqui porque
// exige foto de produção, que a planilha não tem.
function FixImportedDialog({ row, onClose, onSaved }:{ row:HistoryRow; onClose:()=>void; onSaved:(message:string)=>void }) {
  const [options,setOptions]=useState<FieldOption[]|null>(null);
  const [mode,setMode]=useState<"CAMPO"|"NOME"|"SEM">(row.noOperator?"SEM":row.fieldOperatorId?"CAMPO":"NOME");
  const [fieldId,setFieldId]=useState(row.fieldOperatorId?String(row.fieldOperatorId):"");
  const [search,setSearch]=useState("");
  const [name,setName]=useState(row.operatorName??"");
  const [sameName,setSameName]=useState(true);
  const [start,setStart]=useState(row.startReading===null?"":String(row.startReading));
  const [end,setEnd]=useState(row.endReading===null?"":String(row.endReading));
  const [review,setReview]=useState(row.reviewStatus==="CONFERIR");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{ api<{operadores:FieldOption[]}>("/api/daily-records/operator-options").then((data)=>setOptions(data.operadores)).catch((problem)=>{ setOptions([]); setError(problem instanceof Error?problem.message:"Falha ao carregar os funcionários."); }); },[]);
  const key=(value:string)=>value.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
  const visible=(options??[]).filter((item)=>key(item.name).includes(key(search.trim())));
  const parse=(value:string)=>{ const text=value.trim().replace(/\s/g,""); if(!text)return null; const normalized=text.includes(",")?text.replace(/\./g,"").replace(",","."):text; const number=Number(normalized); return Number.isFinite(number)?number:NaN; };
  const canApplySame=!row.fieldOperatorId&&!row.noOperator&&Boolean(row.operatorName);
  async function save() {
    const inicial=parse(start); const final=parse(end);
    if(Number.isNaN(inicial)||Number.isNaN(final)){ setError("Leitura inválida."); return; }
    if(mode==="CAMPO"&&!fieldId){ setError("Escolha o funcionário de campo."); return; }
    setSaving(true); setError("");
    try {
      const response=await fetch(`/api/daily-records/${row.id}/corrigir`,{ method:"PUT", headers:{ "content-type":"application/json" }, body:JSON.stringify({
        operador:mode==="CAMPO"?{ tipo:"CAMPO", id:Number(fieldId) }:mode==="SEM"?{ tipo:"SEM" }:{ tipo:"NOME", nome:name },
        aplicarMesmoNome:canApplySame&&sameName, inicial, final, conferir:review,
      }) });
      const data=await response.json().catch(()=>({})) as { error?:string; message?:string };
      if(!response.ok)throw new Error(data.error??"Não foi possível corrigir.");
      onSaved(data.message??"Registro corrigido.");
    } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível corrigir."); }
    finally { setSaving(false); }
  }
  const unit=row.readingUnit==="KM"?"km":"h";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event)=>{ if(event.target===event.currentTarget&&!saving)onClose(); }}>
    <div className="modal daily-fix-modal" role="dialog" aria-modal="true" aria-label="Corrigir registro importado">
      <header><h3>Corrigir registro importado</h3><p>{row.prefix} · {formatHistoryDay(row.recordDate)} · {row.front??"Sem frente"}</p></header>
      <fieldset className="daily-fix-operator"><legend>Operador {row.operatorName && <small>(na planilha: {row.operatorName})</small>}</legend>
        <label><input type="radio" name="fix-op" checked={mode==="CAMPO"} onChange={()=>setMode("CAMPO")}/>Vincular a funcionário de campo</label>
        {mode==="CAMPO" && <div className="daily-fix-pick">
          <input type="search" value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Buscar funcionário" aria-label="Buscar funcionário"/>
          <select size={6} value={fieldId} onChange={(event)=>setFieldId(event.target.value)} aria-label="Funcionário de campo">
            {options===null ? <option disabled>Carregando...</option> : visible.map((item)=><option key={item.id} value={item.id}>{item.name}{item.active?"":" (inativo)"}</option>)}
          </select>
        </div>}
        <label><input type="radio" name="fix-op" checked={mode==="NOME"} onChange={()=>setMode("NOME")}/>Manter só o nome</label>
        {mode==="NOME" && <input value={name} onChange={(event)=>setName(event.target.value)} placeholder="Nome do operador" aria-label="Nome do operador"/>}
        <label><input type="radio" name="fix-op" checked={mode==="SEM"} onChange={()=>setMode("SEM")}/>Sem operador</label>
        {canApplySame && <label className="daily-fix-same"><input type="checkbox" checked={sameName} onChange={(event)=>setSameName(event.target.checked)}/>Aplicar também aos outros registros sem cadastro com o nome “{row.operatorName}”</label>}
      </fieldset>
      <div className="daily-fix-readings">
        <label>Leitura inicial ({unit})<input inputMode="decimal" value={start} onChange={(event)=>setStart(event.target.value)}/></label>
        <label>Leitura final ({unit})<input inputMode="decimal" value={end} onChange={(event)=>setEnd(event.target.value)}/></label>
      </div>
      <label className="daily-fix-same"><input type="checkbox" checked={review} onChange={(event)=>setReview(event.target.checked)}/>Conferir (não usa a leitura no histórico do equipamento)</label>
      {row.reviewStatus==="CONFERIR" && row.reviewReason && <p className="table-sub">Motivo: {row.reviewReason}</p>}
      {error && <div className="fleet-form-error">! {error}</div>}
      <footer><button type="button" className="secondary" onClick={onClose} disabled={saving}>Cancelar</button><button type="button" className="primary" onClick={save} disabled={saving||options===null}>{saving?"Salvando...":"Salvar correção"}</button></footer>
    </div>
  </div>;
}
