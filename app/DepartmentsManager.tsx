"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";
import { api, jsonBody, problemText } from "./stock-client";

export type Department = { id: number; name: string; active: boolean };

// Lista única de Departamentos (Movimentação e Solicitação de Pedidos). Busca os ativos; quem tem
// "departments.manage" também cadastra na hora pelo seletor (`create`).
export function useDepartments() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [canManage, setCanManage] = useState(false);
  const reload = useCallback(async () => {
    try { const result = await api<{ departments: Department[]; canManage: boolean }>("/api/departments"); setDepartments(result.departments); setCanManage(result.canManage); }
    catch { setDepartments([]); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const create = useCallback(async (name: string) => {
    const result = await api<{ department: Department }>("/api/departments", jsonBody("POST", { name }));
    setDepartments((current) => current.some((row) => row.id === result.department.id) ? current : [...current, result.department].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));
    return result.department;
  }, []);
  return { departments, canManage, create, reload };
}

// Cadastro de Departamentos: incluir, renomear e ativar/desativar (os lançamentos antigos mantêm o nome).
export function DepartmentsModal({ close, changed, flash }: { close: () => void; changed: () => void; flash: (message: string) => void }) {
  const [rows, setRows] = useState<Department[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setRows((await api<{ departments: Department[] }>("/api/departments?todos=1")).departments); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar os departamentos.")); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function run(request: Promise<{ message: string }>) {
    setBusy(true); setError("");
    try { flash((await request).message); await load(); changed(); return true; }
    catch (problem) { setError(problemText(problem, "Não foi possível salvar.")); return false; }
    finally { setBusy(false); }
  }
  return (
    <div className="fleet-modal-backdrop" role="presentation"><section className="fleet-modal departments-modal">
      <header><div><p>CADASTRO</p><h2>Departamentos</h2><span>Lista única usada na Movimentação e na Solicitação de Pedidos.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        <form className="departments-add" onSubmit={async (event) => { event.preventDefault(); if (name.trim() && await run(api("/api/departments", jsonBody("POST", { name })))) setName(""); }}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Novo departamento (ex.: Manutenção da Frota)" aria-label="Novo departamento" />
          <button className="primary" disabled={busy || !name.trim()}>＋ Cadastrar</button>
        </form>
        {!rows ? <div className="page-loading"><span /><p>Carregando...</p></div> : (
          <ul className="departments-list">{rows.map((row) => (
            <li key={row.id} className={row.active ? "" : "inactive"}>
              <strong>{row.name}</strong>{!row.active && <span className="status-pill gray">Desativado</span>}
              <div className="equipment-row-actions">
                <button type="button" disabled={busy} onClick={() => { const value = window.prompt("Novo nome do departamento:", row.name); if (value?.trim() && value.trim() !== row.name) run(api(`/api/departments/${row.id}`, jsonBody("PUT", { name: value }))); }}>Renomear</button>
                <button type="button" disabled={busy} onClick={() => run(api(`/api/departments/${row.id}`, jsonBody("PUT", { active: !row.active })))}>{row.active ? "Desativar" : "Reativar"}</button>
              </div>
            </li>
          ))}</ul>
        )}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer><button type="button" onClick={close}>Fechar</button></footer>
    </section></div>
  );
}
