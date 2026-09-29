// Datas/horas de leitura são gravadas como texto na hora local da operação (America/Fortaleza),
// sem fuso: "AAAA-MM-DDTHH:MM" (ou só "AAAA-MM-DD"). É assim que os formulários mandam
// (<input type="datetime-local">). Valores com fuso ("…Z", "-03:00") vindos de outros caminhos são
// convertidos para esse mesmo formato; assim a ordenação por texto continua cronológica.
const TIME_ZONE = "America/Fortaleza";
const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function toLocalWallTime(value: string): string {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    const map = Object.fromEntries(parts.formatToParts(date).map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
  }
  const local = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return local ? `${local[1]}T${local[2]}` : raw;
}
