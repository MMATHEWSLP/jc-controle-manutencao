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
};

const qty = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const day = (value: string) => value.split("-").reverse().join("/");

// Destino da saída: veículo, funcionário e/ou departamento; abaixo, onde a peça foi aplicada e quem retirou.
function DestinationCell({ row }: { row: StockMovementRow }) {
  const parts = [row.equipment?.prefix, row.employee?.name, row.department?.name].filter((value): value is string => Boolean(value));
  const extra = [row.application && !parts.includes(row.application) ? row.application : null, row.withdrawnBy ? `Retirado por ${row.withdrawnBy}` : null].filter(Boolean);
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
              <td><span className={`status-pill ${row.type === "ENTRADA" ? "green" : "orange"}`}>{row.type === "ENTRADA" ? "Entrada" : "Saída"}</span>{row.reversed && <small className="table-sub">estornado</small>}</td>
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
