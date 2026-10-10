"use client";
import { useEffect, useState } from "react";
import { api, problemText } from "./stock-client";
import ProductionFellingGrid, { type LaunchProject } from "./ProductionFellingGrid";
import type { ProductionFront, ProductionReason } from "./production-client";

// Apontador da Produção no celular (funcionário de campo com producao.lancar): só a derruba do dia, sem
// valores em R$. Usa as rotas /api/producao/campo/* (as únicas da Produção liberadas para o perfil CAMPO).
type FieldContext = { fronts: ProductionFront[]; reasons: ProductionReason[]; projects: LaunchProject[] };

export default function ProductionFieldView({ flash }: { flash: (message: string) => void }) {
  const [context, setContext] = useState<FieldContext | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<FieldContext>("/api/producao/campo/contexto").then(setContext).catch((problem) => setError(problemText(problem, "Não foi possível abrir a Produção.")));
  }, []);
  if (error) return <div className="operation-error"><span>!</span><div><strong>Produção</strong><p>{error}</p></div></div>;
  if (!context) return <div className="page-loading"><span /><p>Carregando...</p></div>;
  return <>
    <div className="page-heading module-heading">
      <div><p className="eyebrow">PRODUÇÃO · DERRUBA</p><h1>Produção do dia</h1><span>Escolha o projeto e a data e preencha uma linha por operador. No fim, toque em Salvar.</span></div>
    </div>
    <article className="panel module-panel production-panel production-field">
      {context.fronts.length === 0
        ? <div className="empty-state">Seu usuário não está vinculado a nenhuma frente de serviço.</div>
        : <ProductionFellingGrid projects={context.projects} reasons={context.reasons.filter((reason) => reason.active)} dayEndpoint="/api/producao/campo/dia" employeesEndpoint="/api/producao/campo/funcionarios" flash={flash} />}
    </article>
  </>;
}
