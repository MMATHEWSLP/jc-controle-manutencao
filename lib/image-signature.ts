// Identifica a imagem pela assinatura binária real (nunca pelo Content-Type informado pelo
// cliente). Mesmo critério da foto do equipamento (app/api/equipment/[id]/photo).
const MAGIC_SIGNATURES: Array<{ contentType: string; extension: string; check: (buffer: Buffer) => boolean }> = [
  { contentType: "image/webp", extension: "webp", check: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { contentType: "image/jpeg", extension: "jpg", check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { contentType: "image/png", extension: "png", check: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
];

export function detectImage(buffer: Buffer) {
  return MAGIC_SIGNATURES.find((format) => format.check(buffer)) ?? null;
}
