"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, problemText } from "./stock-client";
import { clearProductionUrl, FrontFilter, frontsTitle, initialFronts, readProductionUrl, saveFronts, writeProductionUrl, type ProductionContext } from "./production-client";

// Menu PRODUÇÃO: Derruba → Arraste → Medição → Transporte por projeto (fazenda/UPA). As abas e o filtro de
// frentes ficam na URL (?tela=producao&aba=...&sub=...&frentes=1,2) para o link poder ser compartilhado.
// As abas ainda não entregues mostram em que fase do plano (docs/producao/PLANO-FASE-0.md) elas chegam.
function Loading() { return <div className="page-loading"><span /><p>Carregando...</p></div>; }
const ProductionProjectsTab = dynamic(() => import("./ProductionProjectsTab"), { loading: Loading });
const ProductionFellingTab = dynamic(() => import("./ProductionFellingTab"), { loading: Loading });

const TABS = [
  { key: "projetos", label: "Projetos", phase: null },
  { key: "derruba", label: "Derruba", phase: null },
  { key: "arraste", label: "Arraste", phase: 3 },
  { key: "medicao", label: "Medição", phase: 4 },
  { key: "transporte", label: "Transporte", phase: 5 },
  { key: "resumo", label: "Resumo de Projeto", phase: 6 },
  { key: "postar", label: "Postar Produção", phase: 6 },
] as const;
type TabKey = typeof TABS[number]["key"];
const isTab = (value: string | null): value is TabKey => TABS.some((tab) => tab.key === value);

type User = { id: number; name: string };

export default function ProductionView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [context, setContext] = useState<ProductionContext | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>(() => { const aba = readProductionUrl().aba; return isTab(aba) ? aba : "projetos"; });
  const [sub, setSub] = useState<string | null>(() => readProductionUrl().sub);
  const [fronts, setFronts] = useState<number[] | null>(null);

  useEffect(() => {
    api<ProductionContext>("/api/producao/contexto")
      .then((result) => { setContext(result); setFronts(initialFronts(authUser.id, readProductionUrl().frentes, result.fronts)); })
      .catch((problem) => setError(problemText(problem, "Não foi possível abrir a Produção.")));
  }, [authUser.id]);
  useEffect(() => { if (fronts !== null) writeProductionUrl({ aba: tab, sub, frentes: fronts }); }, [tab, sub, fronts]);
  useEffect(() => () => clearProductionUrl(), []);

  const changeFronts = (ids: number[]) => { setFronts(ids); saveFronts(authUser.id, ids); };
  const openTab = (key: TabKey) => { setTab(key); setSub(null); };
  const current = TABS.find((item) => item.key === tab)!;

  if (error) return <div className="operation-error"><span>!</span><div><strong>Produção</strong><p>{error}</p></div></div>;
  if (!context || fronts === null) return <Loading />;
  return <>
    <div className="page-heading module-heading">
      <div><p className="eyebrow">PRODUÇÃO</p><h1>Produção — {frontsTitle(context.fronts, fronts)}</h1><span>Cadeia produtiva por projeto (fazenda/UPA): derruba → arraste → medição → transporte. Cada etapa de cada projeto é finalizada ou reaberta separadamente.</span></div>
    </div>
    <div className="main-tabs secondary-module-nav production-tabs" aria-label="Abas do módulo Produção">
      {TABS.map((item) => <button key={item.key} type="button" className={tab === item.key ? "active" : ""} onClick={() => openTab(item.key)}>{item.label}</button>)}
    </div>
    <FrontFilter fronts={context.fronts} selected={fronts} onChange={changeFronts} />
    {context.fronts.length === 0 && <div className="empty-state">Seu usuário não está vinculado a nenhuma frente de serviço.</div>}
    {tab === "projetos" && <ProductionProjectsTab context={context} selectedFronts={fronts} sub={sub} setSub={setSub} flash={flash} />}
    {tab === "derruba" && <ProductionFellingTab context={context} selectedFronts={fronts} sub={sub} setSub={setSub} flash={flash} />}
    {current.phase !== null && <article className="panel module-panel production-placeholder">
      <h2>{current.label}</h2>
      <p>Esta aba chega na Fase {current.phase} da entrega do módulo. Os projetos, equipes, preços por frente e motivos já podem ser cadastrados na aba Projetos, e a derruba já pode ser lançada na aba Derruba.</p>
    </article>}
  </>;
}
