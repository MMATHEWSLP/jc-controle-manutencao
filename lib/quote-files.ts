import path from "node:path";
import { detectImage } from "./image-signature";

// Orçamentos anexados às Compras: imagem (JPEG/PNG/WebP) ou PDF, conferidos pela assinatura binária
// (nunca pelo tipo informado pelo navegador). Arquivo gravado com nome seguro em uploads/purchase-quotes.
export const QUOTE_DIR = path.join(process.cwd(), "uploads", "purchase-quotes");
export const QUOTE_MAX_BYTES = 10 * 1024 * 1024;

export function detectQuoteFile(buffer: Buffer) {
  if (buffer.length > 5 && buffer.toString("ascii", 0, 5) === "%PDF-") return { contentType: "application/pdf", extension: "pdf" };
  return detectImage(buffer);
}

// Nome original só para exibição (sem caminho e sem caracteres de controle).
export function displayFileName(name: string) {
  return name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, "").slice(0, 120) || "orcamento";
}
