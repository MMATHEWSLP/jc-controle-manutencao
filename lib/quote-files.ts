import path from "node:path";
import { detectImage } from "./image-signature";

// Anexos das Compras, conferidos pela assinatura binária (nunca pelo tipo informado pelo navegador)
// e gravados com nome seguro em uploads/purchase-quotes:
//   PHOTO          foto(s) enviadas na criação do pedido (peça quebrada, problema...) — só imagem;
//   QUOTE_IMAGE    orçamento por imagem (foto/print) — só imagem;
//   QUOTE_DOCUMENT orçamento por documento — PDF, Word, Excel, PowerPoint, OpenDocument, CSV ou TXT.
export const QUOTE_DIR = path.join(process.cwd(), "uploads", "purchase-quotes");
export const QUOTE_MAX_BYTES = 10 * 1024 * 1024;
export type AttachmentKind = "PHOTO" | "QUOTE_IMAGE" | "QUOTE_DOCUMENT";
export const ATTACHMENT_KINDS: AttachmentKind[] = ["PHOTO", "QUOTE_IMAGE", "QUOTE_DOCUMENT"];
export const isAttachmentKind = (value: unknown): value is AttachmentKind => ATTACHMENT_KINDS.includes(value as AttachmentKind);

type Format = { contentType: string; extension: string };

const OOXML: Array<[string, Format]> = [
  ["word/", { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" }],
  ["xl/", { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" }],
  ["ppt/", { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: "pptx" }],
];
const OPEN_DOCUMENT: Array<[string, Format]> = [
  ["application/vnd.oasis.opendocument.text", { contentType: "application/vnd.oasis.opendocument.text", extension: "odt" }],
  ["application/vnd.oasis.opendocument.spreadsheet", { contentType: "application/vnd.oasis.opendocument.spreadsheet", extension: "ods" }],
  ["application/vnd.oasis.opendocument.presentation", { contentType: "application/vnd.oasis.opendocument.presentation", extension: "odp" }],
];
// Formato antigo do Office (DOC/XLS/PPT) tem a mesma assinatura (OLE); o tipo vem da extensão.
const OLE_BY_EXTENSION: Record<string, Format> = {
  doc: { contentType: "application/msword", extension: "doc" },
  xls: { contentType: "application/vnd.ms-excel", extension: "xls" },
  ppt: { contentType: "application/vnd.ms-powerpoint", extension: "ppt" },
};
const TEXT_BY_EXTENSION: Record<string, Format> = {
  csv: { contentType: "text/csv; charset=utf-8", extension: "csv" },
  txt: { contentType: "text/plain; charset=utf-8", extension: "txt" },
};

const extensionOf = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

export function detectDocument(buffer: Buffer, fileName: string): Format | null {
  if (buffer.length > 5 && buffer.toString("ascii", 0, 5) === "%PDF-") return { contentType: "application/pdf", extension: "pdf" };
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    // ZIP: o tipo do OpenDocument fica no arquivo "mimetype" (primeiro, sem compressão); o do
    // Office aparece nos nomes das pastas internas (cabeçalhos e diretório central sem compressão).
    const head = buffer.toString("latin1", 0, Math.min(buffer.length, 200));
    const odf = OPEN_DOCUMENT.find(([marker]) => head.includes(marker));
    if (odf) return odf[1];
    const names = buffer.toString("latin1");
    const office = OOXML.find(([folder]) => names.includes(folder) && names.includes("[Content_Types].xml"));
    return office ? office[1] : null;
  }
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0xd0cf11e0 && buffer.readUInt32BE(4) === 0xa1b11ae1) return OLE_BY_EXTENSION[extensionOf(fileName)] ?? null;
  const text = TEXT_BY_EXTENSION[extensionOf(fileName)];
  if (text && !buffer.includes(0)) return text;
  return null;
}

export function detectAttachment(kind: AttachmentKind, buffer: Buffer, fileName: string): Format | null {
  return kind === "QUOTE_DOCUMENT" ? detectDocument(buffer, fileName) : detectImage(buffer);
}

export const ATTACHMENT_FORMAT_HINT: Record<AttachmentKind, string> = {
  PHOTO: "Envie as fotos em JPEG, PNG ou WebP.",
  QUOTE_IMAGE: "Envie o orçamento por imagem em JPEG, PNG ou WebP (para PDF, Word ou Excel use “Orçamento por documento”).",
  QUOTE_DOCUMENT: "Envie o orçamento em PDF, Word, Excel, PowerPoint, OpenDocument, CSV ou TXT (para foto/print use “Orçamento por imagem”).",
};

// Abre no navegador só o que é seguro exibir (imagem e PDF); o resto é baixado.
export const opensInline = (contentType: string) => contentType.startsWith("image/") || contentType === "application/pdf";

// Nome original só para exibição (sem caminho e sem caracteres de controle).
export function displayFileName(name: string) {
  return name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, "").slice(0, 120) || "anexo";
}
