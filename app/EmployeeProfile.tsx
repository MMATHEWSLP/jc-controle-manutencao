"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";
import { AbsenceForm, CycleEditModal, DismissModal, RehireModal, StepModal, TransferModal } from "./EmployeeForms";
import {
  AlertChip, api, brDay, CYCLE_STEP_LABELS, CYCLE_STEPS, dayCount, initials, localToday, money, nextAction, post, problemText, SituationPills, StageCell,
  type AbsenceKind, type Cycle, type CycleStep, type Employee, type Front,
} from "./employees-client";

type Detail = Employee & {
  canChange?: boolean;
  cycles: Cycle[];
  transfers: Array<{ id: number; transferDate: string; until: string | null; current: boolean; days: number; previousFront: string | null; newFront: string; note: string | null; by: string | null }>;
  absences: Array<{ id: number; kind: AbsenceKind; kindLabel: string; startDate: string; endDate: string | null; days: number; notes: string | null; by: string | null }>;
  dismissals: Array<{ id: number; dismissedAt: string; reason: string; rehireAllowed: boolean; previousAdmissionDate: string | null; rehiredAt: string | null; by: string | null; rehiredBy: string | null }>;
  counters: { workedDaysCurrentCycle: number | null; totalOffDays: number; totalTravelDays: number; cycles: number; tenure: { days: number; label: string } | null };
};

export default function EmployeeProfile({ id, canManage: canManageModule, canSeeSalary, fronts, close, changed, flash, edit }: {
  id: number; canManage: boolean; canSeeSalary: boolean; fronts: Front[]; close: () => void; changed: () => Promise<void>; flash: (message: string) => void; edit: (item: Employee) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [absenceOpen, setAbsenceOpen] = useState(false);
  const [modal, setModal] = useState<null | "transfer" | "dismiss" | "rehire" | { steps: CycleStep[]; label: string } | { cycle: Cycle }>(null);
  const load = useCallback(async () => {
    try { setDetail((await api<{ employee: Detail }>(`/api/employees/${id}`)).employee); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar.")); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  // Funcionário de outra frente: pode consultar e transferir; as demais alterações são da frente dele.
  const canTransfer = canManageModule;
  const canManage = canManageModule && detail?.canChange !== false;
  async function afterChange(message: string) { setAbsenceOpen(false); setModal(null); await Promise.all([load(), changed()]); flash(message); }
  async function closeAbsence(absence: Detail["absences"][number]) {
    const endDate = window.prompt("Data de término/retorno (AAAA-MM-DD):", localToday());
    if (!endDate) return;
    try { await afterChange((await post(`/api/employees/absences/${absence.id}`, { kind: absence.kind, startDate: absence.startDate, endDate }, "PUT")).message); }
    catch (problem) { flash(problemText(problem, "Não foi possível atualizar.")); }
  }
  async function removeAbsence(absence: Detail["absences"][number]) {
    if (!window.confirm(`Excluir o registro de ${absence.kindLabel.toLowerCase()} de ${brDay(absence.startDate)}?`)) return;
    try { await afterChange((await api<{ message: string }>(`/api/employees/absences/${absence.id}`, { method: "DELETE" })).message); }
    catch (problem) { flash(problemText(problem, "Não foi possível excluir.")); }
  }
  async function undoStep() {
    if (!window.confirm("Desfazer a última etapa registrada do ciclo de folga?")) return;
    try { await afterChange((await post(`/api/employees/${id}/cycle-undo`, {})).message); }
    catch (problem) { flash(problemText(problem, "Não foi possível desfazer.")); }
  }

  const dismissed = detail?.status === "DEMITIDO";
  const action = detail ? nextAction(detail) : null;
  const lastDismissal = detail?.dismissals[0] ?? null;
  const current = detail?.cycle ?? null;

  return (
    <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="equipment-sheet equipment-management-sheet employee-profile">
        {!detail ? <div className="page-loading"><span /><p>{error || "Carregando perfil..."}</p></div> : <>
          <header className="sheet-header">
            <div className="sheet-identity"><span className="equipment-avatar sheet-avatar">{initials(detail.name)}</span><div><p>{detail.jobTitle.toUpperCase()}{detail.registration ? ` · MATRÍCULA ${detail.registration}` : ""}</p><h2>{detail.name}</h2><span>{detail.company} · {detail.frontName}{dismissed ? "" : ` · há ${dayCount(detail.daysInFront)} nesta frente`}</span></div></div>
            <button className="sheet-close" onClick={close} aria-label="Fechar">×</button>
          </header>
          {canTransfer && (
            <div className="sheet-actions employee-profile-actions">
              <div><SituationPills item={detail} />{!canManage && <small className="table-sub">Funcionário de outra frente: consulta e transferência.</small>}</div>
              {canManage && <button className="secondary" onClick={() => edit(detail)}>Editar cadastro</button>}
              {!dismissed && <button className="secondary" onClick={() => setModal("transfer")}>Transferir de frente</button>}
              {canManage && !dismissed && <button className="secondary danger-action" onClick={() => setModal("dismiss")}>Demitir</button>}
              {canManage && dismissed && <button className="primary" onClick={() => setModal("rehire")}>Readmitir</button>}
            </div>
          )}
          <div className="sheet-content">
            {dismissed && lastDismissal && (
              <div className={`employee-dismissed-banner ${lastDismissal.rehireAllowed ? "" : "restricted"}`}>
                <strong>Demitido em {brDay(lastDismissal.dismissedAt)}{lastDismissal.rehireAllowed ? " · pode ser recontratado" : " · FUNCIONÁRIO RESTRITO (não pode ser recontratado)"}</strong>
                {lastDismissal.reason && <span>Motivo: {lastDismissal.reason}</span>}
              </div>
            )}
            <div className="employee-counters">
              <article><small>Dias trabalhados (ciclo atual)</small><strong>{dayCount(detail.counters.workedDaysCurrentCycle)}</strong>{current && <em>meta {current.workDaysTarget}</em>}</article>
              <article><small>Total de folga</small><strong>{dayCount(detail.counters.totalOffDays)}</strong><em>{detail.counters.cycles} ciclo(s)</em></article>
              <article><small>Total em viagem</small><strong>{dayCount(detail.counters.totalTravelDays)}</strong><em>ida + volta</em></article>
              <article><small>Tempo de casa</small><strong>{detail.counters.tenure?.label ?? "—"}</strong><em>desde {brDay(detail.admissionDate)}</em></article>
              <article><small>Nesta frente</small><strong>{dismissed ? "—" : dayCount(detail.daysInFront)}</strong><em>{detail.frontName}</em></article>
            </div>

            {!dismissed && (
              <article className="sheet-card employee-current-cycle">
                <div className="sheet-card-head">
                  <div><h3>Ciclo de folga atual{current ? ` · nº ${current.cycleNumber}` : ""}</h3><p>{current ? `${current.summary.phaseLabel} · ${detail.cycleWorkDays} trabalhados / ${detail.cycleOffDays} de folga` : "Ciclo não iniciado — informe o início do ciclo."}</p></div>
                  <div className="employee-cycle-head-actions"><AlertChip alert={current?.summary.alert} />{canManage && action && <button className="primary" onClick={() => setModal(action)}>{action.label}</button>}{canManage && current && <button onClick={undoStep}>Desfazer última etapa</button>}</div>
                </div>
                <ol className="employee-cycle-steps">
                  {CYCLE_STEPS.map((step) => {
                    const value = current?.[step] ?? null;
                    const summary = current?.summary;
                    const span = step === "frontDeparture" ? summary?.workedDays : step === "homeArrival" ? summary?.travelOutDays : step === "homeDeparture" ? summary?.offDays : step === "frontArrival" ? summary?.travelBackDays : null;
                    const spanLabel = step === "frontDeparture" ? "trabalhados" : step === "homeArrival" ? "viagem ida" : step === "homeDeparture" ? "folga" : "viagem volta";
                    return (
                      <li key={step} className={value ? "done" : summary?.nextStep === step || (!current && step === "workStart") ? "next" : ""}>
                        {step !== "workStart" && <span className="employee-cycle-span">{span === null || span === undefined ? "—" : `${span}d`} <small>{spanLabel}</small></span>}
                        <b>{CYCLE_STEP_LABELS[step]}</b><strong>{brDay(value)}</strong>
                      </li>
                    );
                  })}
                </ol>
              </article>
            )}

            <div className="sheet-summary-grid">
              <article className="sheet-card equipment-data">
                <div className="sheet-card-head"><h3>Dados do funcionário</h3><span>♙</span></div>
                <dl>
                  <div><dt>Matrícula</dt><dd>{detail.registration ?? "—"}</dd></div>
                  {canSeeSalary && <div><dt>CPF</dt><dd>{detail.cpf ?? "—"}</dd></div>}
                  <div><dt>Função</dt><dd>{detail.jobTitle}</dd></div>
                  <div><dt>Empresa (vínculo)</dt><dd>{detail.company}</dd></div>
                  <div><dt>Admissão</dt><dd>{brDay(detail.admissionDate)}</dd></div>
                  {canSeeSalary && <div><dt>Nascimento</dt><dd>{brDay(detail.birthDate)}</dd></div>}
                  <div><dt>Situação</dt><dd>{detail.situationLabel}{detail.atHeadquarters ? " · fica na sede" : ""}</dd></div>
                  <div><dt>Cidade</dt><dd>{detail.city ?? "—"}</dd></div>
                  {canSeeSalary && <div><dt>Salário de carteira</dt><dd>{money(detail.salary)}</dd></div>}
                  <div><dt>Ciclo configurado</dt><dd>{detail.cycleWorkDays} trabalhados / {detail.cycleOffDays} de folga</dd></div>
                  <div><dt>Frente atual</dt><dd>{detail.frontName}</dd></div>
                  {detail.notes && <div className="wide"><dt>Observações</dt><dd>{detail.notes}</dd></div>}
                </dl>
              </article>
              <article className="sheet-card">
                <div className="sheet-card-head"><div><h3>Frentes</h3><p>Permanência em cada frente (transferências).</p></div></div>
                <div className="transfer-history">
                  {detail.transfers.map((record) => <div key={record.id}><span>↔</span><p><strong>{record.newFront}{record.current ? " (atual)" : ""} · {dayCount(record.days)}</strong><small>{brDay(record.transferDate)} a {record.until ? brDay(record.until) : "hoje"}{record.previousFront && record.previousFront !== record.newFront ? ` · veio de ${record.previousFront}` : ""}{record.note ? ` · ${record.note}` : ""}{record.by ? ` · ${record.by}` : ""}</small></p></div>)}
                  {detail.transfers.length === 0 && <div className="empty-state">Sem transferências registradas.</div>}
                </div>
              </article>
            </div>

            <article className="sheet-card">
              <div className="sheet-card-head"><div><h3>Histórico de ciclos de folga</h3><p>Datas lançadas e dias calculados de cada ciclo.</p></div></div>
              <div className="table-scroll">
                <table className="equipment-management-table employee-cycles-table">
                  <thead><tr><th title="Número do ciclo">Ciclo</th><th title="Início do ciclo → saída da frente · dias trabalhados">Trabalho</th><th title="Saída da frente → chegada em casa · dias de viagem (ida)">Viagem ida</th><th title="Chegada em casa → saída de casa · dias de folga">Folga</th><th title="Saída de casa → chegada na frente · dias de viagem (volta)">Viagem volta</th><th>Situação</th>{canManage && !dismissed && <th>Ações</th>}</tr></thead>
                  <tbody>
                    {detail.cycles.map((cycle) => (
                      <tr key={cycle.id}>
                        <td>{cycle.cycleNumber}</td>
                        <td><StageCell from={cycle.workStart} to={cycle.frontDeparture} days={cycle.summary.workedDays} /></td>
                        <td><StageCell from={cycle.frontDeparture} to={cycle.homeArrival} days={cycle.summary.travelOutDays} /></td>
                        <td><StageCell from={cycle.homeArrival} to={cycle.homeDeparture} days={cycle.summary.offDays} /></td>
                        <td><StageCell from={cycle.homeDeparture} to={cycle.frontArrival} days={cycle.summary.travelBackDays} /></td>
                        <td>{cycle.summary.phaseLabel}{cycle.notes && <small className="table-sub" title={cycle.notes}> · obs.</small>}</td>
                        {canManage && !dismissed && <td><div className="equipment-row-actions"><button onClick={() => setModal({ cycle })}>Corrigir datas</button></div></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.cycles.length === 0 && <div className="empty-state">Nenhum ciclo de folga registrado.</div>}
              </div>
            </article>

            <article className="sheet-card">
              <div className="sheet-card-head"><div><h3>Afastamentos</h3><p>Férias, atestado médico, afastamento ou outra ausência. A folga é controlada pelo ciclo acima.</p></div>{canManage && !dismissed && !absenceOpen && <button onClick={() => setAbsenceOpen(true)}>＋ Registrar afastamento</button>}</div>
              {absenceOpen && <AbsenceForm employeeId={detail.id} cancel={() => setAbsenceOpen(false)} saved={afterChange} />}
              <div className="table-scroll">
                <table className="equipment-management-table employee-absences-table">
                  <thead><tr><th>Tipo</th><th title="Início → término (ou em aberto) · dias">Período</th><th>Observações</th>{canManage && <th>Ações</th>}</tr></thead>
                  <tbody>
                    {detail.absences.map((absence) => (
                      <tr key={absence.id} className={detail.currentAbsence?.id === absence.id ? "employee-absence-current" : ""}>
                        <td>{absence.kindLabel}{detail.currentAbsence?.id === absence.id && <span className="employee-absence-badge">vigente</span>}</td>
                        <td><span className="stage-cell"><b>{brDay(absence.startDate)} → {absence.endDate ? brDay(absence.endDate) : "em aberto"}</b><small>{absence.days} dia{absence.days === 1 ? "" : "s"}</small></span></td>
                        <td>{absence.notes ?? "—"}<small className="table-sub">Registrado por {absence.by ?? "—"}</small></td>
                        {canManage && <td><div className="equipment-row-actions">{!absence.endDate && <button onClick={() => closeAbsence(absence)}>Informar retorno</button>}<button onClick={() => removeAbsence(absence)}>Excluir</button></div></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.absences.length === 0 && <div className="empty-state">Nenhum afastamento registrado.</div>}
              </div>
            </article>

            <article className="sheet-card">
              <div className="sheet-card-head"><div><h3>Demissões e readmissões</h3><p>Histórico com o motivo de cada saída.</p></div></div>
              <div className="transfer-history">
                {detail.dismissals.map((record) => <div key={record.id}><span>{record.rehireAllowed ? "⇥" : "⛔"}</span><p><strong>Demitido em {brDay(record.dismissedAt)} · {record.rehireAllowed ? "pode ser recontratado" : "não pode ser recontratado"}</strong><small>Motivo: {record.reason}{record.previousAdmissionDate ? ` · admissão anterior ${brDay(record.previousAdmissionDate)}` : ""}{record.by ? ` · por ${record.by}` : ""}{record.rehiredAt ? ` · readmitido em ${brDay(record.rehiredAt)}${record.rehiredBy ? ` por ${record.rehiredBy}` : ""}` : ""}</small></p></div>)}
                {detail.dismissals.length === 0 && <div className="empty-state">Nenhuma demissão registrada.</div>}
              </div>
            </article>
          </div>
        </>}
      </section>
      {detail && modal === "transfer" && <TransferModal item={detail} fronts={fronts} close={() => setModal(null)} saved={afterChange} />}
      {detail && modal === "dismiss" && <DismissModal item={detail} close={() => setModal(null)} saved={afterChange} />}
      {detail && modal === "rehire" && <RehireModal item={detail} fronts={fronts} restricted={lastDismissal && !lastDismissal.rehireAllowed && !lastDismissal.rehiredAt ? lastDismissal : null} close={() => setModal(null)} saved={afterChange} />}
      {detail && modal && typeof modal === "object" && "steps" in modal && <StepModal employees={[detail]} steps={modal.steps} title={modal.label} close={() => setModal(null)} saved={afterChange} />}
      {detail && modal && typeof modal === "object" && "cycle" in modal && <CycleEditModal cycle={modal.cycle} isOpen={modal.cycle.id === current?.id} close={() => setModal(null)} saved={afterChange} />}
    </div>
  );
}
