// Formatação de datas no padrão brasileiro, igual no navegador e no servidor.
// - "AAAA-MM-DD" (data sem hora) é mostrada como está, sem passar por fuso: new Date("2026-07-05")
//   é meia-noite UTC e, em Brasília, virava 04/07 às 21:00.
// - "AAAA-MM-DDTHH:MM" (hora local, sem fuso — formato dos formulários) também é mostrada como está.
// - Valores com fuso (ISO "…Z") são convertidos para o horário de Fortaleza.
const WITH_TIME = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Fortaleza", dateStyle: "short", timeStyle: "short" });
const DATE_ONLY = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Fortaleza", dateStyle: "short" });

export function formatBrDate(value: string | null | undefined, withTime = true, empty = "—"): string {
  if (!value) return empty;
  const raw = String(value).trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) return `${day[3]}/${day[2]}/${day[1]}`;
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(:\d{2}(\.\d+)?)?$/.exec(raw);
  if (local) return withTime ? `${local[3]}/${local[2]}/${local[1]}, ${local[4]}:${local[5]}` : `${local[3]}/${local[2]}/${local[1]}`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return (withTime ? WITH_TIME : DATE_ONLY).format(date);
}
