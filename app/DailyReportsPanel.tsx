"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from "react";

// RELATÓRIOS → Produção do Controle Diário (por frente/local/operador/equipamento: KM/horas, viagens,
// volume no porto, diesel informado) e RELATÓRIOS → Conferência Diário x Combustível, com Excel e PDF.
// mode fixa um dos dois (cada um é um cartão do catálogo); sem mode mostra as duas abas.
type Front = { id: number; name: string };
type Equip = { id: number; prefix: string };
type Producao = { chave: string; registros: number; importados: number; conferir: number; km: number; horas: number; viagensPorto: number; volumePorto: number; torasPorto: number; viagensBaldeio: number; viagens: number; dieselInformado: number };
type Diesel = { equipmentId: number; prefixo: string; dia: string; diario: number; combustivel: number; diferenca: number; registros: number; saidas: number; operadores: string | null; nota: boolean };

const n = (valor: number, casas = 2) => valor.toLocaleString("pt-BR", { maximumFractionDigits: casas });
const dia = (valor: string) => valor.split("-").reverse().join("/");
function hoje() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

export default function DailyReportsPanel({ fronts, equipment, mode }: { fronts: Front[]; equipment: Equip[]; mode?: "producao" | "diesel" }) {
  const [tipo, setTipo] = useState<"producao" | "diesel">(mode ?? "producao");
  const [por, setPor] = useState<"frente" | "local" | "operador" | "equipamento">("frente");
  const [de, setDe] = useState(`${hoje().slice(0, 7)}-01`);
  const [ate, setAte] = useState(hoje());
  const [frente, setFrente] = useState("");
  const [equip, setEquip] = useState("");
  const [operador, setOperador] = useState("");
  const [local, setLocal] = useState("");
  const [origem, setOrigem] = useState("");
  const [dados, setDados] = useState<{ linhas: Array<Producao | Diesel>; totais?: { diario: number; combustivel: number } } | null>(null);
  const [error, setError] = useState("");
  const params = useMemo(() => {
    const p = new URLSearchParams({ tipo, de, ate });
    if (tipo === "producao") p.set("por", por);
    if (frente) p.set("frente", frente); if (equip) p.set("equipamento", equip); if (operador.trim()) p.set("operador", operador.trim());
    if (local.trim()) p.set("local", local.trim()); if (origem) p.set("origem", origem);
    return p.toString();
  }, [tipo, por, de, ate, frente, equip, operador, local, origem]);
  useEffect(() => {
    setError("");
    const timer = window.setTimeout(() => {
      fetch(`/api/daily-records/reports?${params}`, { cache: "no-store" }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error); setDados(data); })
        .catch((problem) => setError(problem instanceof Error ? problem.message : "Falha ao carregar o relatório."));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [params]);
  const producao = tipo === "producao" ? (dados?.linhas ?? []) as Producao[] : [];
  const diesel = tipo === "diesel" ? (dados?.linhas ?? []) as Diesel[] : [];
  const total = producao.reduce((t, x) => ({ registros: t.registros + x.registros, km: t.km + x.km, horas: t.horas + x.horas, viagens: t.viagens + x.viagens, volume: t.volume + x.volumePorto, diesel: t.diesel + x.dieselInformado }), { registros: 0, km: 0, horas: 0, viagens: 0, volume: 0, diesel: 0 });

  return <article className="panel module-panel daily-reports">
    {!mode && <div className="main-tabs secondary-module-nav daily-reports-tabs">
      <button type="button" className={tipo === "producao" ? "active" : ""} onClick={() => { setTipo("producao"); setDados(null); }}>Produção e KM/horas</button>
      <button type="button" className={tipo === "diesel" ? "active" : ""} onClick={() => { setTipo("diesel"); setDados(null); }}>Diário x Combustível</button>
    </div>}
    <div className="daily-reports-filters">
      {tipo === "producao" && <label>Agrupar por<select value={por} onChange={(event) => setPor(event.target.value as typeof por)}><option value="frente">Frente</option><option value="local">Local</option><option value="operador">Operador</option><option value="equipamento">Equipamento</option></select></label>}
      <label>De<input type="date" value={de} max={ate} onChange={(event) => event.target.value && setDe(event.target.value)} /></label>
      <label>Até<input type="date" value={ate} min={de} onChange={(event) => event.target.value && setAte(event.target.value)} /></label>
      <label>Frente<select value={frente} onChange={(event) => setFrente(event.target.value)}><option value="">Todas</option>{fronts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Equipamento<select value={equip} onChange={(event) => setEquip(event.target.value)}><option value="">Todos</option>{equipment.map((item) => <option key={item.id} value={item.id}>{item.prefix}</option>)}</select></label>
      <label>Operador<input value={operador} onChange={(event) => setOperador(event.target.value)} placeholder="Nome" /></label>
      <label>Local<input value={local} onChange={(event) => setLocal(event.target.value)} placeholder="Ex.: Concessão" /></label>
      <label>Origem<select value={origem} onChange={(event) => setOrigem(event.target.value)}><option value="">Todos</option><option value="APP">Feitos no app</option><option value="IMPORTADO">Importados</option></select></label>
      <div className="fuel-export-actions"><a className="secondary" href={`/api/daily-records/reports?${params}&formato=xlsx`}>Excel</a><a className="secondary" href={`/api/daily-records/reports?${params}&formato=pdf`}>PDF</a></div>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!dados && !error ? <div className="page-loading"><span /><p>Montando relatório...</p></div> : tipo === "producao" ? <>
      <p className="stock-summary">{n(total.registros, 0)} registro(s) · {n(total.km, 0)} km · {n(total.horas, 1)} h · {n(total.viagens, 0)} viagens · {n(total.volume)} m³ no porto · {n(total.diesel, 0)} L de diesel informado (não é saída de combustível). KM/horas só dos registros sem “Conferir”.</p>
      <div className="table-scroll"><table className="products-table daily-import-table"><thead><tr><th>{por === "frente" ? "Frente" : por === "local" ? "Local" : por === "operador" ? "Operador" : "Equipamento"}</th><th>Registros</th><th>KM</th><th>Horas</th><th>Viagens porto</th><th>Volume (m³)</th><th>Toras</th><th>Viagens baldeio</th><th>Total viagens</th><th>Diesel informado</th></tr></thead>
        <tbody>{producao.map((x) => <tr key={x.chave}><td><strong>{x.chave}</strong>{(x.importados > 0 || x.conferir > 0) && <small className="table-sub">{x.importados} importado(s){x.conferir ? ` · ${x.conferir} conferir` : ""}</small>}</td>
          <td>{x.registros}</td><td className="price-cell">{n(x.km, 0)}</td><td className="price-cell">{n(x.horas, 1)}</td><td>{x.viagensPorto}</td><td className="price-cell">{n(x.volumePorto)}</td><td>{x.torasPorto}</td><td>{x.viagensBaldeio}</td><td><strong>{x.viagens}</strong></td><td className="price-cell">{n(x.dieselInformado, 0)} L</td></tr>)}</tbody></table>
        {producao.length === 0 && <div className="empty-state">Nenhum registro no período e filtros.</div>}</div>
    </> : <>
      <p className="stock-summary">Diário {n(dados?.totais?.diario ?? 0, 0)} L · Combustível {n(dados?.totais?.combustivel ?? 0, 0)} L · diferença {n((dados?.totais?.diario ?? 0) - (dados?.totais?.combustivel ?? 0), 0)} L. Por equipamento e dia, maiores diferenças primeiro.</p>
      <div className="table-scroll"><table className="products-table daily-import-table"><thead><tr><th>Data</th><th>Equipamento</th><th>Diário</th><th>Combustível</th><th>Diferença</th><th>Operadores</th></tr></thead>
        <tbody>{diesel.map((x) => <tr key={`${x.equipmentId}-${x.dia}`} className={Math.abs(x.diferenca) > 50 ? "warn" : ""}><td>{dia(x.dia)}</td><td><strong>{x.prefixo}</strong></td><td className="price-cell">{n(x.diario)} L{x.nota && <small className="table-sub">acima de 600 L não lançado</small>}</td>
          <td className="price-cell">{n(x.combustivel)} L<small className="table-sub">{x.saidas} saída(s)</small></td><td className="price-cell"><strong>{n(x.diferenca)} L</strong></td><td><small>{x.operadores ?? "—"}</small></td></tr>)}</tbody></table>
        {diesel.length === 0 && <div className="empty-state">Nada no período e filtros.</div>}</div>
    </>}
  </article>;
}
