"use client";

// Tabela de movimentações de estoque (aba Histórico do produto e Histórico da Movimentação). Cada
// linha mostra o número do lançamento de origem (PED-/SAI-/OS-/SOL-) para rastrear de onde veio.
export type StockMovementRow = {
  id: number; date: string; type: "ENTRADA" | "SAIDA"; quantity: number; source: string; sourceLabel: string; originNumber: string;
  workOrderOpen: boolean; product: { id: number; tag: string; name: string }; front: string;
  equipment: { id: number; prefix: string | null } | null; employee: { id: number; name: string | null } | null;
  department?: { id: number; name: string | null } | null;
  application: string | null; withdrawnBy: string | null; unitPrice: number | null; total: number | null;
  reason: string; reversed: boolean; createdBy: string | null;
  // Histórico importado do sistema antigo (Produtos → Importar movimentações).
  correction?: boolean; historyOnly?: boolean; destination?: string | null; owner?: string | null;
  // Saída para terceiro: empresa e o destino (veículo ou funcionário da empresa).
  thirdParty?: { id: number; name: string | null; plate: string | null; receivedBy: string | null; employee: string | null; destination: string | null } | null;
};

const qty = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const day = (value: string) => value.split("-").reverse().join("/");

// Destino da saída: veículo, funcionário e/ou departamento; abaixo, onde a peça foi aplicada e quem retirou.
function DestinationCell({ row }: { row: StockMovementRow }) {
  const party = row.thirdParty;
  const partyText = party ? [party.name, party.employee ? `Funcionário: ${party.employee}` : party.plate ? `Veículo: ${party.plate}` : null].filter(Boolean).join(" · ") : null;
  const parts = [row.equipment?.prefix, row.employee?.name, row.department?.name, partyText].filter((value): value is string => Boolean(value));
  const extra = [row.application && !party && !parts.includes(row.application) ? row.application : null, party?.receivedBy ? `Recebido por ${party.receivedBy}` : null, row.withdrawnBy ? `Retirado por ${row.withdrawnBy}` : null,
    row.destination && row.destination !== row.application ? `Local: ${row.destination}` : null, row.owner ? `Proprietário: ${row.owner}` : null].filter(Boolean);
  return <>{parts.length ? parts.join(" · ") : "—"}{extra.length > 0 && <small className="table-sub">{extra.join(" · ")}</small>}</>;
}

export default function StockMovementsTable({ rows, showProduct, empty }: { rows: StockMovementRow[]; showProduct: boolean; empty: string }) {
  return (
    <div className="table-scroll">
      <table className="stock-movements-table">
        <thead>
          <tr>
            <th>Data</th>
            <th title="Entrada ou saída">Tipo</th>
            {showProduct && <th>Produto</th>}
            <th title="Número do lançamento de origem e o módulo">Origem</th>
            <th title="Veículo, funcionário e/ou departamento de destino · onde a peça foi aplicada">Destino / aplicação</th>
            <th title="Quantidade movimentada">Qtd.</th>
            <th title="Valor unitário · total">Valor</th>
            <th title="Frente do estoque · quem lançou">Frente</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.reversed ? "stock-row-reversed" : ""}>
              <td>{day(row.date)}</td>
              <td>{row.correction ? <span className="status-pill gray">Correção</span> : <span className={`status-pill ${row.type === "ENTRADA" ? "green" : "orange"}`}>{row.type === "ENTRADA" ? "Entrada" : "Saída"}</span>}{row.reversed && <small className="table-sub">estornado</small>}{row.historyOnly && <small className="table-sub" title="Importado do sistema antigo: não alterou o saldo atual">só histórico</small>}</td>
              {showProduct && <td><strong>{row.product.tag}</strong><small className="table-sub">{row.product.name}</small></td>}
              <td><strong>{row.originNumber}</strong><small className="table-sub">{row.sourceLabel}{row.workOrderOpen ? " · O.S. aberta" : ""}</small></td>
              <td><DestinationCell row={row} /></td>
              <td>{row.type === "SAIDA" ? "−" : "+"}{qty.format(row.quantity)}</td>
              <td>{row.unitPrice === null ? "—" : money.format(row.unitPrice)}{row.total !== null && <small className="table-sub">Total {money.format(row.total)}</small>}</td>
              <td>{row.front}<small className="table-sub">{row.createdBy ?? "—"}</small></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty-state">{empty}</div>}
    </div>
  );
}
