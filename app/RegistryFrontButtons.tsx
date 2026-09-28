"use client";

type Front = { id: number; name: string };

// Botões de frente dentro de Equipamentos e Funcionários ("Todos", "Arapiuns", "Flexal"...). Só
// aparecem para quem tem a permissão de ver todas as frentes nesses módulos e NÃO tem o seletor
// global do topo (a API devolve `frontButtons` já com essa regra — lib/active-front.ts).
export default function RegistryFrontButtons({ fronts, value, onChange }: { fronts: Front[]; value: number | "ALL"; onChange: (value: number | "ALL") => void }) {
  return (
    <div className="main-tabs secondary-module-nav registry-front-buttons" role="tablist" aria-label="Frente em exibição neste módulo">
      <button type="button" role="tab" aria-selected={value === "ALL"} className={value === "ALL" ? "active" : ""} onClick={() => onChange("ALL")}>Todos</button>
      {fronts.map((front) => <button type="button" role="tab" key={front.id} aria-selected={value === front.id} className={value === front.id ? "active" : ""} onClick={() => onChange(front.id)}>{front.name}</button>)}
    </div>
  );
}

export const frontParam = (value: number | "ALL") => (value === "ALL" ? "" : `frente=${value}`);
