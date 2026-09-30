// ---------------------------------------------------------------------------
// Conciliação do tanque: a medição física (régua ou litros lidos no visor) é comparada com o
// saldo que o sistema calcula (entradas − saídas). A diferença mostra perda (medido < sistema) ou
// sobra (medido > sistema). Regras puras, sem banco, para testar isoladamente.
// ---------------------------------------------------------------------------

export const DEFAULT_TOLERANCE_PERCENT = 1;
export type CalibrationPoint = [number, number]; // [centímetros, litros]
export type ReconciliationStatus = "OK" | "PERDA" | "SOBRA";

// Tabela de arqueação colada como texto: uma linha por ponto, "cm;litros" (aceita ; , tab ou
// espaço como separador e vírgula decimal quando o separador não é vírgula).
export function parseCalibration(text: string): { points?: CalibrationPoint[]; error?: string } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { points: [] };
  const points: CalibrationPoint[] = [];
  for (const [index, line] of lines.entries()) {
    const parts = line.includes(";") || line.includes("\t") ? line.split(/[;\t]/) : line.includes(" ") ? line.split(/\s+/) : line.split(",");
    const values = parts.map((part) => Number(part.trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")));
    if (values.length !== 2 || values.some((value) => !Number.isFinite(value) || value < 0))
      return { error: `Linha ${index + 1} da tabela inválida: "${line}". Use "centímetros;litros".` };
    points.push([values[0], values[1]]);
  }
  points.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < points.length; index++) {
    if (points[index][0] === points[index - 1][0]) return { error: `Centímetro ${points[index][0]} repetido na tabela.` };
    if (points[index][1] < points[index - 1][1]) return { error: `Os litros precisam aumentar junto com os centímetros (confira ${points[index][0]} cm).` };
  }
  if (points.length < 2) return { error: "A tabela precisa de pelo menos 2 pontos (ex.: 0;0 e a altura máxima)." };
  return { points };
}

// Litros para uma altura da régua, interpolando entre os dois pontos vizinhos da tabela.
export function litersFromRuler(points: CalibrationPoint[], cm: number): number | null {
  if (points.length < 2 || !Number.isFinite(cm) || cm < points[0][0] || cm > points[points.length - 1][0]) return null;
  for (let index = 1; index < points.length; index++) {
    const [cm1, liters1] = points[index];
    if (cm <= cm1) {
      const [cm0, liters0] = points[index - 1];
      return Math.round((liters0 + (liters1 - liters0) * ((cm - cm0) / (cm1 - cm0))) * 100) / 100;
    }
  }
  return null;
}

// Diferença = medido − sistema. Percentual sobre o saldo do sistema; fora da tolerância vira
// PERDA (faltou combustível) ou SOBRA (tem mais que o sistema diz — normalmente entrada não lançada).
export function reconcile(measured: number, calculated: number, tolerancePercent = DEFAULT_TOLERANCE_PERCENT) {
  const difference = Math.round((measured - calculated) * 100) / 100;
  const percent = calculated > 0 ? Math.round((difference / calculated) * 10000) / 100 : null;
  const tolerance = Math.max(0, tolerancePercent);
  const outside = percent === null ? Math.abs(difference) > 0.5 : Math.abs(percent) > tolerance + 1e-9;
  const status: ReconciliationStatus = !outside ? "OK" : difference < 0 ? "PERDA" : "SOBRA";
  return { difference, percent, status };
}
