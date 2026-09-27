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
};
type HistoryResult = { rows:HistoryRow[]; total:number; page:number; pages:number; pageSize:number };

// Marca a URL como "tela do Histórico" (app/page.tsx abre o Controle Diário direto nela ao recarregar).
export const HISTORY_SCREEN_PARAM = "tela";
export const HISTORY_SCREEN_VALUE = "historico-diario";
export function isHistoryUrl() { return typeof window !== "undefined" && new URLSearchParams(window.location.search).get(HISTORY_SCREEN_PARAM) === HISTORY_SCREEN_VALUE; }
export function clearHistoryUrl() { if (isHistoryUrl()) window.history.replaceState(window.history.state, "", window.location.pathname); }

const emptyFilters:DailyHistoryFilters = { q:"", from:"", to:"", frontId:null, operators:[] };
function readUrl() { const params=new URLSearchParams(window.location.search); return { filters:parseHistoryFilters(params), page:parseHistoryPage(params) }; }

async function api<T>(url:string):Promise<T> { const response=await fetch(url,{ cache:"no-store" }); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }

// defaultFrontId = frente do seletor global do topo: vira o filtro padrão quando o link não traz outro.
export default function DailyHistoryPanel({ fronts, onEdit, defaultFrontId=null }:{ fronts:Front[]; onEdit:(recordId:number)=>Promise<void>; defaultFrontId?:number|null }) {
  const [initial]=useState(()=>{ const value=typeof window==="undefined"?{ filters:emptyFilters, page:1 }:readUrl(); return value.filters.frontId||!defaultFrontId||!fronts.some((front)=>front.id===defaultFrontId)?value:{ ...value, filters:{ ...value.filters, frontId:defaultFrontId } }; });
  const [filters,setFilters]=useState<DailyHistoryFilters>(initial.filters);
  const [page,setPage]=useState(initial.page);
  // Texto digitado na lupa: aplicado com um pequeno atraso para não consultar a cada tecla.
  const [queryInput,setQueryInput]=useState(initial.filters.q);
  const [operators,setOperators]=useState<string[]>([]);
  const [result,setResult]=useState<HistoryResult|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [opening,setOpening]=useState<number|null>(null);
  const [exporting,setExporting]=useState<"pdf"|"xlsx"|null>(null);
  const [exportError,setExportError]=useState("");

  const change=useCallback((changes:Partial<DailyHistoryFilters>)=>{ setFilters((current)=>({ ...current, ...changes })); setPage(1); },[]);
  useEffect(()=>{ const q=queryInput.trim(); if(q===filters.q)return; const timer=window.setTimeout(()=>change({ q }),350); return ()=>window.clearTimeout(timer); },[queryInput,filters.q,change]);

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

  const active=Boolean(filters.q||filters.from||filters.to||filters.frontId||filters.operators.length);
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
    </div>

    <div className="daily-history-toolbar">
      <span>{loading&&!result?"Carregando...":`${total.toLocaleString("pt-BR")} registro(s)`}{active && <button type="button" className="daily-history-clear" onClick={()=>{ setQueryInput(""); setFilters(emptyFilters); setPage(1); }}>Limpar filtros</button>}</span>
      <div>
        <button type="button" className="secondary" disabled={total===0||exporting!==null} onClick={()=>exportFile("pdf")} title={total===0?"Nenhum registro para exportar":"Exportar a lista filtrada em PDF"}>{exporting==="pdf"?"Gerando...":"PDF"}</button>
        <button type="button" className="secondary" disabled={total===0||exporting!==null} onClick={()=>exportFile("xlsx")} title={total===0?"Nenhum registro para exportar":"Exportar a lista filtrada em Excel"}>{exporting==="xlsx"?"Gerando...":"Excel"}</button>
      </div>
    </div>
    {exportError && <div className="fleet-form-error">! {exportError}</div>}
    {error && <div className="fleet-form-error">! {error}</div>}

    <div className={`daily-history-list ${loading&&result?"is-loading":""}`}>
      {loading&&!result ? <div className="page-loading"><span/><p>Carregando registros...</p></div> : <>
        {result && result.rows.length>0 && <div className="daily-history-head" aria-hidden="true"><span>Data</span><span>Equipamento</span><span>Operador</span><span>Frente</span><span>Horas/KM trab.</span><span>Status</span><span/></div>}
        {result?.rows.map((row)=><HistoryItem key={row.id} row={row} opening={opening===row.id} onEdit={()=>edit(row)}/>)}
        {result && result.rows.length===0 && <div className="empty-state">{active?"Nenhum registro encontrado para os filtros selecionados.":"Nenhum registro lançado ainda."}</div>}
      </>}
    </div>

    {result && result.pages>1 && <nav className="daily-history-pages" aria-label="Paginação do histórico">
      <button type="button" className="secondary" disabled={page<=1||loading} onClick={()=>setPage(page-1)}>‹ Anterior</button>
      <span>Página {result.page} de {result.pages}</span>
      <button type="button" className="secondary" disabled={page>=result.pages||loading} onClick={()=>setPage(page+1)}>Próxima ›</button>
    </nav>}
  </article>;
}

function HistoryItem({ row, opening, onEdit }:{ row:HistoryRow; opening:boolean; onEdit:()=>void }) {
  const tags=historyStatusTags(row);
  const tone=!row.workedToday?"off":row.inactiveOrProblem?"warn":"ok";
  const detail=!row.workedToday?row.noWorkReason:row.inactiveOrProblem?row.problemReason:null;
  return <div className={`daily-history-row ${tone}`}>
    <span className="dh-date">{formatHistoryDay(row.recordDate)}</span>
    <span className="dh-equipment"><strong>{row.prefix}</strong>{row.equipmentModel && <small>{row.equipmentModel}</small>}</span>
    <span className="dh-operator"><b>{row.operator}</b>{row.manualEntry && <em className="daily-manual-tag" title={`Lançado pela conta ${row.launchedBy}`}>Lançamento manual</em>}</span>
    <span className="dh-front">{row.front??"Sem frente"}{row.location && <small>{row.location}</small>}</span>
    <span className="dh-worked">{formatWorked(row.worked,row.readingUnit)}</span>
    <span className="dh-status" title={detail??undefined}>{tags.map((tag)=><i key={tag.key} className={`status-pill ${tag.tone}`}>{tag.label}</i>)}</span>
    <span className="dh-actions">{row.canEdit && <button type="button" className="daily-history-edit" onClick={onEdit} disabled={opening} aria-label={`Editar registro de ${row.prefix} em ${formatHistoryDay(row.recordDate)}`} title="Editar registro">{opening?"…":"✎"}</button>}</span>
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
