import { PDF_LOGO_HEIGHT, PDF_LOGO_JPEG_BASE64, PDF_LOGO_WIDTH } from "./pdf-logo";

export type FleetPdfItem = {
  occurrenceId: string;
  prefix: string;
  model: string;
  category: string;
  front: string;
  startedAt: string;
  endedAt: string | null;
  returnedAt: string | null;
  reason: string;
  currentStatus: string;
  mechanics: string[];
  servicePerformed: string;
  orders: string[];
  duration: string;
};

export type FleetPdfInput = {
  reportDate: string;
  generatedAt: string;
  filters: string;
  metrics: {
    fleet: number;
    operating: number;
    stoppedInPeriod: number;
    maintenance: number;
    waitingPart: number;
    released: number;
    occurrences: number;
  };
  stillStopped: FleetPdfItem[];
  released: FleetPdfItem[];
};

const cp1252: Record<number, number> = { 0x2013:150, 0x2014:151, 0x2018:145, 0x2019:146, 0x201c:147, 0x201d:148, 0x2022:149, 0x2026:133 };
function encodeBinary(value: string) { const bytes: number[] = []; for (const character of value) { const code = character.codePointAt(0) ?? 63; bytes.push(code <= 255 ? code : cp1252[code] ?? 63); } return Uint8Array.from(bytes); }
function escapePdf(value: string) { return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"); }
function text(x: number, y: number, size: number, value: string, bold = false, color = "0.12 0.20 0.27") { return `${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${escapePdf(value)}) Tj ET\n`; }
function truncate(value: string, max: number) { const normalized = value.replace(/\s+/g, " ").trim() || "—"; return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1))}…`; }
function fromBase64(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function binaryString(value: Uint8Array) { let output = ""; for (const byte of value) output += String.fromCharCode(byte); return output; }
function logo(x: number, y: number, width: number) { const height = width * (PDF_LOGO_HEIGHT / PDF_LOGO_WIDTH); return `q ${width} 0 0 ${height.toFixed(2)} ${x} ${y} cm /Logo Do Q\n`; }

function buildPdf(rawPages: string[]) {
  const pages = rawPages.length ? rawPages : [""];
  const regularFontId = 3 + pages.length * 2;
  const boldFontId = regularFontId + 1;
  const logoId = boldFontId + 1;
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`];
  pages.forEach((content, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const contentBytes = encodeBinary(content);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> /XObject << /Logo ${logoId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`);
  });
  const logoBytes = fromBase64(PDF_LOGO_JPEG_BASE64);
  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Type /XObject /Subtype /Image /Width ${PDF_LOGO_WIDTH} /Height ${PDF_LOGO_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoBytes.length} >>\nstream\n${binaryString(logoBytes)}\nendstream`,
  );
  const chunks: Uint8Array[] = [encodeBinary("%PDF-1.4\n%âãÏÓ\n")];
  const offsets = [0]; let offset = chunks[0].length;
  objects.forEach((object, index) => { offsets.push(offset); const chunk = encodeBinary(`${index + 1} 0 obj\n${object}\nendobj\n`); chunks.push(chunk); offset += chunk.length; });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const item of offsets.slice(1)) xref += `${String(item).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(encodeBinary(xref));
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0; for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length; }
  return output;
}

function header(input: FleetPdfInput, page: number, pages: number) {
  let content = "";
  content += "1 1 1 rg 0 514 842 81 re f\n";
  content += "0.12 0.49 0.68 rg 0 509 842 5 re f\n";
  content += logo(28, 530, 86);
  content += text(126, 568, 8, "JC FLORESTAIS", true, "0.05 0.50 0.35");
  content += text(126, 547, 16, "STATUS DA FROTA", true, "0.05 0.22 0.32");
  content += text(126, 530, 8, `RELATÓRIO DIÁRIO · ${input.reportDate}`, false, "0.31 0.45 0.53");
  content += text(653, 568, 7, "GERADO EM", true, "0.31 0.45 0.53");
  content += text(653, 551, 8, truncate(input.generatedAt, 27), false, "0.05 0.22 0.32");
  content += text(653, 532, 7, `PÁGINA ${page}/${pages}`, true, "0.12 0.49 0.68");
  return content;
}

function summary(input: FleetPdfInput) {
  const cards = [
    ["FROTA", input.metrics.fleet], ["OPERANDO", input.metrics.operating], ["PARADOS NO PERÍODO", input.metrics.stoppedInPeriod],
    ["EM MANUTENÇÃO", input.metrics.maintenance], ["AGUARD. PEÇA", input.metrics.waitingPart], ["LIBERADOS", input.metrics.released], ["OCORRÊNCIAS", input.metrics.occurrences],
  ] as const;
  let content = "";
  cards.forEach(([label, value], index) => {
    const x = 28 + index * 112;
    const color = label === "PARADOS NO PERÍODO" ? "0.72 0.12 0.18" : label === "LIBERADOS" || label === "OPERANDO" ? "0.05 0.45 0.32" : "0.08 0.31 0.43";
    content += `0.955 0.972 0.98 rg ${x} 454 106 43 re f\n`;
    content += text(x + 8, 482, 6, label, true, "0.39 0.50 0.57");
    content += text(x + 8, 462, 14, String(value), true, color);
  });
  content += text(30, 438, 6.5, `FILTROS: ${truncate(input.filters, 170)}`, false, "0.37 0.48 0.55");
  return content;
}

function itemBlock(item: FleetPdfItem, top: number, index: number) {
  let content = "";
  if (index % 2 === 0) content += `0.969 0.978 0.983 rg 28 ${top - 72} 786 80 re f\n`;
  content += text(38, top - 4, 11, truncate(item.prefix, 12), true, "0.04 0.27 0.39");
  content += text(38, top - 20, 6.5, truncate(item.model, 25), false, "0.36 0.47 0.54");
  content += text(38, top - 34, 6.5, truncate(`${item.category} · ${item.front}`, 29), false, "0.36 0.47 0.54");
  content += text(166, top - 3, 7, "ENTRADA DA PARADA", true, "0.39 0.49 0.56");
  content += text(166, top - 18, 8, item.startedAt, true);
  content += text(166, top - 35, 7, `TEMPO: ${item.duration}`, true, "0.72 0.24 0.16");
  content += text(305, top - 3, 7, "MOTIVO / STATUS", true, "0.39 0.49 0.56");
  content += text(305, top - 18, 8, truncate(item.reason, 47), true);
  content += text(305, top - 34, 7, truncate(item.currentStatus, 47), false, "0.72 0.24 0.16");
  content += text(535, top - 3, 7, "MECÂNICOS", true, "0.39 0.49 0.56");
  content += text(535, top - 18, 7.5, truncate(item.mechanics.join(", ") || "Não informado", 48), true);
  content += text(535, top - 35, 7, truncate(`Pedido: ${item.orders.join(" · ") || "Nenhum"}`, 58), false, "0.32 0.43 0.50");
  content += text(166, top - 55, 7, `SERVIÇO: ${truncate(item.servicePerformed || "Em andamento / não concluído", 118)}`, false, "0.17 0.30 0.38");
  if (item.endedAt) content += text(535, top - 55, 7, `CONCLUSÃO: ${item.endedAt}${item.returnedAt ? ` · OPERAÇÃO: ${item.returnedAt}` : ""}`, true, "0.05 0.45 0.32");
  content += `0.86 0.90 0.92 RG 0.4 w 28 ${top - 74} m 814 ${top - 74} l S\n`;
  return content;
}

export function createFleetStatusPdf(input: FleetPdfInput) {
  const definitions: Array<{ title: string; tone: string; items: FleetPdfItem[] }> = [];
  const pageSize = 4;
  const pushSection = (title: string, tone: string, items: FleetPdfItem[]) => {
    if (!items.length) { definitions.push({ title, tone, items: [] }); return; }
    for (let index = 0; index < items.length; index += pageSize) definitions.push({ title, tone, items: items.slice(index, index + pageSize) });
  };
  pushSection("EQUIPAMENTOS AINDA PARADOS", "0.72 0.12 0.18", input.stillStopped);
  pushSection("EQUIPAMENTOS LIBERADOS NO DIA", "0.05 0.45 0.32", input.released);
  const pageCount = definitions.length;
  const pages = definitions.map((definition, pageIndex) => {
    let content = header(input, pageIndex + 1, pageCount) + summary(input);
    content += text(28, 413, 12, definition.title, true, definition.tone);
    if (!definition.items.length) content += text(295, 335, 11, "Nenhum equipamento nesta seção.", true, "0.38 0.49 0.56");
    definition.items.forEach((item, index) => { content += itemBlock(item, 385 - index * 86, index); });
    content += "0.86 0.90 0.92 RG 0.6 w 28 28 m 814 28 l S\n";
    content += text(32, 13, 7, "Relatório baseado no histórico de ocorrências. Mudanças posteriores não apagam os eventos deste dia.", false, "0.40 0.50 0.57");
    return content;
  });
  return buildPdf(pages);
}
