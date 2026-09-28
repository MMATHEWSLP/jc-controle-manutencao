// Numeração exibida dos lançamentos que movimentam estoque. O número é sempre derivado do id
// (nunca gravado), então não existe risco de repetir ou pular. Sem dependências.
const pad = (id: number) => String(id).padStart(6, "0");

export const materialRequestNumber = (id: number) => `SOL-${pad(id)}`;
export const purchaseOrderNumber = (id: number) => `PED-${pad(id)}`;
export const stockExitNumber = (id: number) => `SAI-${pad(id)}`;
export const workOrderNumber = (id: number) => `OS-${pad(id)}`;

// "OS-000123", "os 123", "123" (quando o prefixo é o esperado) → 123. Qualquer outra coisa → null.
export function parseDocumentNumber(value: unknown, prefix: "SOL" | "PED" | "SAI" | "OS"): number | null {
  const text = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const match = new RegExp(`^(?:${prefix}-?)?0*(\\d{1,9})$`).exec(text);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
