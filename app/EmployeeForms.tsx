"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ABSENCE_OPTIONS, api, brDay, CYCLE_STEP_LABELS, CYCLE_STEPS, FormError, localToday, Modal, nameKey, post, problemText, STATUS_OPTIONS,
  type Company, type Cycle, type CycleStep, type Employee, type Front, type Restricted,
} from "./employees-client";

type Saved = (message: string) => Promise<void>;
const onlyDigits = (value: string) => value.replace(/\D/g, "");

// Cadastro / edição. Situação: "De folga" acompanha o ciclo e "Demitido" só pelo botão Demitir.
export function EmployeeForm({ item, fronts, companies, canSeeSalary, close, saved }: {
  item: Employee | null; fronts: Front[]; companies: Company[]; canSeeSalary: boolean; close: () => void; saved: Saved;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(item?.name ?? "");
  const [cpf, setCpf] = useState(item?.cpf ?? "");
  const [registration, setRegistration] = useState(item?.registration ?? "");
  const [restricted, setRestricted] = useState<Restricted[]>([]);
  const [showRestricted, setShowRestricted] = useState(false);
  useEffect(() => { if (!item) api<{ restricted: Restricted[] }>("/api/employees/restricted").then((result) => setRestricted(result.restricted)).catch(() => setRestricted([])); }, [item]);
  const matches = useMemo(() => {
    const key = nameKey(name);
    return restricted.filter((row) => (key.split(" ").length >= 2 && nameKey(row.name) === key) || (onlyDigits(cpf).length === 11 && row.cpf && onlyDigits(row.cpf) === onlyDigits(cpf)) || (registration && row.registration === registration));
  }, [restricted, name, cpf, registration]);
  const companyOptions = companies.filter((company) => company.active || company.name === item?.company);
  const manualStatus = !item || item.status === "ATIVO" || item.status === "AFASTADO" || item.status === "FOLGA";

  async function send(payload: Record<string, unknown>): Promise<void> {
    try { await saved((await post(item ? `/api/employees/${item.id}` : "/api/employees", payload, item ? "PUT" : "POST")).message); }
    catch (problem) {
      const data = (problem as Error & { data?: { restricted?: Restricted[] } }).data;
      if (data?.restricted?.length && !payload.confirmRestricted) {
        const names = data.restricted.map((row) => `• ${row.name} — demitido em ${brDay(row.dismissedAt)} (${row.reason})`).join("\n");
        if (window.confirm(`Atenção: este cadastro confere com Funcionário Restrito (não pode ser recontratado):\n${names}\n\nCadastrar mesmo assim?`)) return send({ ...payload, confirmRestricted: true });
      }
      setError(problemText(problem, "Não foi possível salvar."));
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    await send(Object.fromEntries(new FormData(event.currentTarget).entries()));
    setBusy(false);
  }

  return (
    <Modal wide eyebrow="FUNCIONÁRIOS" title={item ? "Editar funcionário" : "Cadastrar funcionário"} subtitle={item ? "A frente atual muda só pela transferência (fica no histórico)." : "Campos com * são obrigatórios."} close={close}>
      <form className="modal-form employee-form" onSubmit={submit}>
        <label>Matrícula<input name="registration" inputMode="numeric" value={registration} onChange={(event) => setRegistration(onlyDigits(event.target.value))} placeholder="Somente números" autoComplete="off" /></label>
        <label className="span-2">Nome completo *<input name="name" required value={name} onChange={(event) => setName(event.target.value)} style={{ textTransform: "uppercase" }} autoComplete="off" /></label>
        <label>Função / Cargo *<input name="jobTitle" required defaultValue={item?.jobTitle} placeholder="Ex.: Operador de Baldeio" style={{ textTransform: "uppercase" }} /></label>
        {item ? <label>Frente de serviço atual<input value={item.frontName} disabled /></label> : (
          <label>Frente de serviço *<select name="serviceFrontId" required defaultValue={fronts.length === 1 ? String(fronts[0].id) : ""}><option value="">Selecione a frente</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
        )}
        <label>Empresa *<select name="company" required defaultValue={item?.company ?? ""}><option value="">Selecione a empresa</option>{companyOptions.map((company) => <option key={company.id} value={company.name}>{company.name}{company.active ? "" : " (desativada)"}</option>)}</select></label>
        <label>Admissão *<input name="admissionDate" type="date" required defaultValue={item?.admissionDate} max={localToday()} /></label>
        <label>Nascimento<input name="birthDate" type="date" defaultValue={item?.birthDate ?? ""} max={localToday()} /></label>
        <label>Cidade<input name="city" defaultValue={item?.city ?? ""} style={{ textTransform: "uppercase" }} /></label>
        <label>CPF<input name="cpf" inputMode="numeric" value={cpf} onChange={(event) => setCpf(event.target.value.replace(/[^\d.-]/g, "").slice(0, 14))} placeholder="000.000.000-00" autoComplete="off" /></label>
        {canSeeSalary && <label>Salário de carteira (R$)<input name="salary" type="number" min="0" step="0.01" defaultValue={item?.salary ?? ""} placeholder="0,00" /></label>}
        <label>Status *
          <select name="status" required defaultValue={item?.status ?? "ATIVO"} disabled={!manualStatus}>
            {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value} disabled={value === "DEMITIDO" || (value === "FOLGA" && item?.status !== "FOLGA")}>{label}{value === "FOLGA" ? " (pelo ciclo)" : value === "DEMITIDO" ? " (botão Demitir)" : ""}</option>)}
          </select>
        </label>
        <fieldset className="employee-cycle-config span-2">
          <legend>Ciclo de folga</legend>
          <label>Dias trabalhados *<input name="cycleWorkDays" type="number" min="1" max="365" required defaultValue={item?.cycleWorkDays ?? 90} /></label>
          <label>Dias de folga *<input name="cycleOffDays" type="number" min="1" max="120" required defaultValue={item?.cycleOffDays ?? 10} /></label>
          <small>Padrão 90 trabalhados / 10 de folga. A folga só conta a partir da chegada em casa.</small>
        </fieldset>
        <label className="full">Observações<textarea name="notes" rows={2} defaultValue={item?.notes ?? ""} /></label>
        {!item && (
          <div className="employee-restricted-box full">
            {matches.length > 0 && <div className="employee-restricted-match"><strong>⚠ Confere com Funcionário Restrito (não pode ser recontratado):</strong>{matches.map((row) => <span key={row.id}>{row.name} · {row.company} · demitido em {brDay(row.dismissedAt)} — {row.reason}</span>)}</div>}
            <button type="button" className="link-button" onClick={() => setShowRestricted((value) => !value)}>{showRestricted ? "Ocultar" : "Ver"} lista de Funcionários Restritos ({restricted.length})</button>
            {showRestricted && <ul className="employee-restricted-list">{restricted.map((row) => <li key={row.id}><strong>{row.name}</strong><small>{[row.company, row.cpf, row.registration ? `Mat. ${row.registration}` : null, `demitido em ${brDay(row.dismissedAt)}`, row.reason].filter(Boolean).join(" · ")}</small></li>)}{restricted.length === 0 && <li><small>Nenhum funcionário restrito.</small></li>}</ul>}
          </div>
        )}
        <FormError error={error} />
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar funcionário"}</button></div>
      </form>
    </Modal>
  );
}

export function TransferModal({ item, fronts, close, saved }: { item: Employee; fronts: Front[]; close: () => void; saved: Saved }) {
  const [destination, setDestination] = useState("");
  const [transferDate, setTransferDate] = useState(localToday());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try { await saved((await post(`/api/employees/${item.id}/transfer`, { newServiceFrontId: Number(destination), transferDate, note })).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível transferir.")); }
    finally { setBusy(false); }
  }
  return (
    <Modal eyebrow="TRANSFERÊNCIA ENTRE FRENTES" title={`Transferir ${item.name}`} subtitle="O cadastro, os ciclos de folga e o histórico de frentes são mantidos." close={close}>
      <div className="transfer-route">
        <div><small>Frente atual</small><strong>{item.frontName}</strong></div><span>→</span>
        <label>Transferir para<select value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">Selecione a frente</option>{fronts.filter((front) => front.id !== item.serviceFrontId).map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
      </div>
      <label className="transfer-note">Data da transferência<input type="date" value={transferDate} max={localToday()} onChange={(event) => setTransferDate(event.target.value)} /></label>
      <label className="transfer-note">Observação (opcional)<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Motivo ou contexto da transferência" /></label>
      <FormError error={error} />
      <footer><button className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy || !destination || !transferDate} onClick={confirm}>{busy ? "Salvando..." : "Confirmar transferência"}</button></footer>
    </Modal>
  );
}

// Etapa(s) do ciclo de folga para um ou vários funcionários. A primeira data é obrigatória; as
// seguintes (ex.: Chegada em casa no "Iniciar folga") são opcionais.
export function StepModal({ employees, steps, title, close, saved }: { employees: Employee[]; steps: CycleStep[]; title: string; close: () => void; saved: Saved }) {
  const [dates, setDates] = useState<Partial<Record<CycleStep, string>>>({ [steps[0]]: localToday() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try { await saved((await post("/api/employees/cycles", { employeeIds: employees.map((item) => item.id), dates })).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível registrar.")); }
    finally { setBusy(false); }
  }
  const shown = employees.slice(0, 8);
  return (
    <Modal eyebrow="CICLO DE FOLGA" title={title} subtitle={employees.length === 1 ? employees[0].name : `${employees.length} funcionários selecionados`} close={close}>
      {employees.length > 1 && <ul className="employee-step-names">{shown.map((item) => <li key={item.id}>{item.name}</li>)}{employees.length > shown.length && <li>e mais {employees.length - shown.length}...</li>}</ul>}
      <div className="employee-step-fields">
        {steps.map((step, index) => (
          <label key={step}>{CYCLE_STEP_LABELS[step]}{index === 0 ? " *" : " (opcional)"}
            <input type="date" value={dates[step] ?? ""} max={localToday()} required={index === 0} onChange={(event) => setDates((current) => ({ ...current, [step]: event.target.value || undefined }))} />
          </label>
        ))}
      </div>
      {steps.includes("homeArrival") && steps[0] !== "homeArrival" && <p className="employee-step-hint">Os dias de folga só começam a contar a partir da chegada em casa. Se ainda não chegou, deixe em branco e registre depois na aba Em viagem.</p>}
      <FormError error={error} />
      <footer><button className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy || !dates[steps[0]]} onClick={confirm}>{busy ? "Salvando..." : employees.length > 1 ? `Aplicar a ${employees.length}` : "Confirmar"}</button></footer>
    </Modal>
  );
}

export function DismissModal({ item, close, saved }: { item: Employee; close: () => void; saved: Saved }) {
  const [dismissedAt, setDismissedAt] = useState(localToday());
  const [reason, setReason] = useState("");
  const [rehireAllowed, setRehireAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try { await saved((await post(`/api/employees/${item.id}/dismiss`, { dismissedAt, reason, rehireAllowed })).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível registrar a demissão.")); }
    finally { setBusy(false); }
  }
  return (
    <Modal eyebrow="DEMISSÃO" title={`Demitir ${item.name}`} subtitle="Sai das listas ativas; perfil e histórico continuam disponíveis para consulta." close={close}>
      <label className="transfer-note">Data da demissão *<input type="date" value={dismissedAt} max={localToday()} onChange={(event) => setDismissedAt(event.target.value)} /></label>
      <label className="transfer-note">Motivo *<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex.: pedido de demissão, fim de contrato, justa causa..." /></label>
      <fieldset className="employee-rehire-choice">
        <legend>Pode ser recontratado? *</legend>
        <label><input type="radio" name="rehire" checked={rehireAllowed === true} onChange={() => setRehireAllowed(true)} /> Sim</label>
        <label><input type="radio" name="rehire" checked={rehireAllowed === false} onChange={() => setRehireAllowed(false)} /> Não — incluir em Funcionários Restritos</label>
      </fieldset>
      <FormError error={error} />
      <footer><button className="secondary" onClick={close}>Cancelar</button><button className="primary danger-action" disabled={busy || !dismissedAt || reason.trim().length < 3 || rehireAllowed === null} onClick={confirm}>{busy ? "Salvando..." : "Confirmar demissão"}</button></footer>
    </Modal>
  );
}

export function RehireModal({ item, fronts, restricted, close, saved }: { item: Employee; fronts: Front[]; restricted: { reason: string } | null; close: () => void; saved: Saved }) {
  const [admissionDate, setAdmissionDate] = useState(localToday());
  const [frontId, setFrontId] = useState(String(item.serviceFrontId));
  const [confirmRestricted, setConfirmRestricted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try { await saved((await post(`/api/employees/${item.id}/rehire`, { admissionDate, serviceFrontId: Number(frontId), confirmRestricted })).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível readmitir.")); }
    finally { setBusy(false); }
  }
  return (
    <Modal eyebrow="READMISSÃO" title={`Readmitir ${item.name}`} subtitle="A admissão anterior fica guardada no histórico de demissões." close={close}>
      {restricted && <div className="employee-restricted-match"><strong>⚠ Funcionário Restrito — marcado como “não pode ser recontratado”.</strong><span>Motivo da demissão: {restricted.reason}</span><label><input type="checkbox" checked={confirmRestricted} onChange={(event) => setConfirmRestricted(event.target.checked)} /> Estou ciente e quero readmitir mesmo assim</label></div>}
      <label className="transfer-note">Nova data de admissão *<input type="date" value={admissionDate} max={localToday()} onChange={(event) => setAdmissionDate(event.target.value)} /></label>
      <label className="transfer-note">Frente de serviço<select value={frontId} onChange={(event) => setFrontId(event.target.value)}>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}{!fronts.some((front) => front.id === item.serviceFrontId) && <option value={item.serviceFrontId}>{item.frontName}</option>}</select></label>
      <FormError error={error} />
      <footer><button className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy || !admissionDate || Boolean(restricted && !confirmRestricted)} onClick={confirm}>{busy ? "Salvando..." : "Readmitir"}</button></footer>
    </Modal>
  );
}

// Correção das datas de um ciclo já lançado.
export function CycleEditModal({ cycle, isOpen, close, saved }: { cycle: Cycle; isOpen: boolean; close: () => void; saved: Saved }) {
  const [dates, setDates] = useState<Record<CycleStep, string>>(Object.fromEntries(CYCLE_STEPS.map((step) => [step, cycle[step] ?? ""])) as Record<CycleStep, string>);
  const [workDaysTarget, setWorkDaysTarget] = useState(String(cycle.workDaysTarget));
  const [offDaysTarget, setOffDaysTarget] = useState(String(cycle.offDaysTarget));
  const [notes, setNotes] = useState(cycle.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try { await saved((await post(`/api/employees/cycles/${cycle.id}`, { ...dates, workDaysTarget: Number(workDaysTarget), offDaysTarget: Number(offDaysTarget), notes }, "PUT")).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível salvar.")); }
    finally { setBusy(false); }
  }
  return (
    <Modal wide eyebrow="CICLO DE FOLGA" title={`Corrigir ciclo nº ${cycle.cycleNumber}`} subtitle="Os dias são recalculados automaticamente a partir das datas." close={close}>
      <div className="modal-form">
        {CYCLE_STEPS.map((step) => (
          <label key={step}>{CYCLE_STEP_LABELS[step]}<input type="date" value={dates[step]} max={localToday()} disabled={step === "frontArrival" && isOpen} onChange={(event) => setDates((current) => ({ ...current, [step]: event.target.value }))} />{step === "frontArrival" && isOpen && <small>Fecha o ciclo: use a etapa “Chegada na frente”.</small>}</label>
        ))}
        <label>Meta de dias trabalhados<input type="number" min="1" max="365" value={workDaysTarget} onChange={(event) => setWorkDaysTarget(event.target.value)} /></label>
        <label>Meta de dias de folga<input type="number" min="1" max="120" value={offDaysTarget} onChange={(event) => setOffDaysTarget(event.target.value)} /></label>
        <label className="full">Observações<input value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <FormError error={error} />
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy} onClick={confirm}>{busy ? "Salvando..." : "Salvar ciclo"}</button></div>
      </div>
    </Modal>
  );
}

export function CompaniesModal({ companies, close, changed }: { companies: Company[]; close: () => void; changed: (message: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<{ message: string }>) {
    setBusy(true);
    setError("");
    try { await changed((await action()).message); setName(""); }
    catch (problem) { setError(problemText(problem, "Não foi possível salvar.")); }
    finally { setBusy(false); }
  }
  function rename(company: Company) {
    const next = window.prompt(`Novo nome para ${company.name} (os cadastros acompanham):`, company.name);
    if (next && next.trim() && next.trim().toUpperCase() !== company.name) run(() => post(`/api/employees/companies/${company.id}`, { name: next }, "PUT"));
  }
  return (
    <Modal eyebrow="FUNCIONÁRIOS" title="Empresas" subtitle="Lista do campo Empresa no cadastro. Desativada some do cadastro, mas quem já está nela continua." close={close}>
      <form className="employee-company-add" onSubmit={(event) => { event.preventDefault(); if (name.trim()) run(() => post("/api/employees/companies", { name })); }}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome da nova empresa" style={{ textTransform: "uppercase" }} />
        <button className="primary" disabled={busy || !name.trim()}>Adicionar</button>
      </form>
      <FormError error={error} />
      <ul className="employee-company-list">
        {companies.map((company) => (
          <li key={company.id} className={company.active ? "" : "inactive"}>
            <div><strong>{company.name}</strong><small>{company.employees} funcionário(s) ativos{company.active ? "" : " · desativada"}</small></div>
            <button disabled={busy} onClick={() => rename(company)}>Renomear</button>
            <button disabled={busy} onClick={() => run(() => post(`/api/employees/companies/${company.id}`, { active: !company.active }, "PUT"))}>{company.active ? "Desativar" : "Ativar"}</button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function AbsenceForm({ employeeId, cancel, saved }: { employeeId: number; cancel: () => void; saved: Saved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try { await saved((await post(`/api/employees/${employeeId}/absences`, Object.fromEntries(new FormData(event.currentTarget).entries()))).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível registrar.")); }
    finally { setBusy(false); }
  }
  return (
    <form className="modal-form employee-absence-form" onSubmit={submit}>
      <label>Tipo *<select name="kind" required defaultValue="ATESTADO">{ABSENCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Início *<input name="startDate" type="date" required defaultValue={localToday()} /></label>
      <label>Término<input name="endDate" type="date" /><small>Em branco = em aberto</small></label>
      <label className="full">Observações<input name="notes" placeholder="Ex.: CID, motivo, combinado com a supervisão..." /></label>
      <FormError error={error} />
      <div className="modal-footer full"><button type="button" className="secondary" onClick={cancel}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Registrar"}</button></div>
    </form>
  );
}
