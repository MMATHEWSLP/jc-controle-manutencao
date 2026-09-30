"use client";
import { useCallback, useEffect, useState } from "react";
import LoadWarning from "./LoadWarning";
import { formatBrDate } from "../lib/date-format";

type Group = { key: string; title: string; description: string; where: string; severity: "ALTA" | "MEDIA" | "BAIXA"; total: number; summary?: string; columns: Array<[string, string]>; rows: Array<Record<string, unknown>> };
const SEVERITY: Record<Group["severity"], [string, string]> = { ALTA: ["red", "Alta"], MEDIA: ["orange", "Média"], BAIXA: ["gray", "Baixa"] };
const cell = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return formatBrDate(text);
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return text;
};

// Tela "Pendências": problemas de dados para corrigir, agrupados e com o caminho de onde corrigir.
export default function PendenciasView() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/pendencias", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Não foi possível carregar as pendências.");
      setGroups(data.groups);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar as pendências."); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);
  const pending = groups?.filter((group) => group.total > 0) ?? [];
  const clean = groups?.filter((group) => group.total === 0) ?? [];
  return <>
    <div className="page-heading module-heading">
      <div><p className="eyebrow">QUALIDADE DOS DADOS</p><h1>Pendências</h1><span>O que precisa de correção manual nos cadastros e lançamentos. Nada aqui altera dados: cada item diz onde corrigir.</span></div>
      <div className="heading-actions"><button className="secondary" onClick={load}>Atualizar</button></div>
    </div>
    <LoadWarning message={error} />
    {!groups && !error && <div className="page-loading">Carregando...</div>}
    {groups && pending.length === 0 && <div className="empty-state">Nenhuma pendência. Tudo em ordem.</div>}
    <div className="pendencias-list">
      {pending.map((group) => {
        const [tone, label] = SEVERITY[group.severity];
        const expanded = open === group.key;
        return <article key={group.key} className="panel module-panel pendencia-card">
          <button type="button" className="pendencia-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : group.key)}>
            <span className={`status-pill ${tone}`}>{label}</span>
            <strong>{group.title}</strong>
            <b className="pendencia-count">{group.total.toLocaleString("pt-BR")}</b>
            <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
          </button>
          <p className="table-sub">{group.description}{group.summary ? ` · ${group.summary}` : ""}</p>
          <p className="pendencia-where">Onde corrigir: <b>{group.where}</b></p>
          {expanded && <div className="table-scroll"><table>
            <thead><tr>{group.columns.map(([, title]) => <th key={title}>{title}</th>)}</tr></thead>
            <tbody>{group.rows.map((row, index) => <tr key={index}>{group.columns.map(([key]) => <td key={key}>{cell(row[key])}</td>)}</tr>)}</tbody>
          </table>{group.rows.length < group.total && <p className="table-sub">Mostrando {group.rows.length} de {group.total.toLocaleString("pt-BR")}.</p>}</div>}
        </article>;
      })}
    </div>
    {clean.length > 0 && <p className="table-sub pendencias-ok">Sem pendência: {clean.map((group) => group.title).join(" · ")}.</p>}
  </>;
}
