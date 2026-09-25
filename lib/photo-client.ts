// Otimização de foto no navegador antes do envio (mesma abordagem da foto do equipamento
// em app/page.tsx): aplica a orientação EXIF, reduz para no máximo 1600px no lado maior e
// converte para WebP. Reencodar via canvas descarta os metadados originais (inclusive GPS).
export async function optimizePhoto(file: File): Promise<Blob> {
  const looksHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  if (!file.type.startsWith("image/") && !looksHeic) throw new Error("Selecione um arquivo de imagem (JPEG, PNG ou WebP).");
  if (file.size > 15 * 1024 * 1024) throw new Error("A imagem original deve ter no máximo 15 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    if (looksHeic) throw new Error("Este navegador não consegue ler fotos HEIC. No iPhone, use Ajustes > Câmera > Formatos > \"Mais compatível\".");
    throw new Error("Não foi possível ler esta imagem. Tente outra foto.");
  }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Não foi possível processar esta imagem neste navegador.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  if (!blob) throw new Error("Não foi possível otimizar a imagem.");
  return blob;
}
