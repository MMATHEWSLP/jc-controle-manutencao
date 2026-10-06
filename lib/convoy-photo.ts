// Foto do abastecimento do comboio no celular: reduz para no máximo 1280 px no lado maior, grava em
// JPEG ~70% e imprime no canto data, hora e localização (GPS, se disponível) — o carimbo fica na
// própria imagem, então vale mesmo se a foto for vista fora do sistema. Reencodar pelo canvas
// descarta os metadados originais do arquivo.
export type GpsPosition = { latitude: number; longitude: number; accuracy: number | null };

export const MAX_SIDE = 1280;
export const JPEG_QUALITY = 0.7;

export function currentPosition(timeoutMs = 10000): Promise<GpsPosition | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (position) => { clearTimeout(timer); resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null }); },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

export function stampLines(takenAt: Date, gps: GpsPosition | null, extra: string[] = []) {
  const when = takenAt.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const where = gps ? `GPS ${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}${gps.accuracy !== null ? ` (±${Math.round(gps.accuracy)} m)` : ""}` : "GPS indisponível";
  return [when, where, ...extra.filter(Boolean)];
}

export async function stampPhoto(file: Blob, lines: string[]): Promise<Blob> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("Não foi possível ler a foto. Tire de novo."); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Este celular não conseguiu processar a foto.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Carimbo no canto inferior esquerdo: fundo escuro translúcido e texto branco.
  const size = Math.max(14, Math.round(Math.min(canvas.width, canvas.height) * 0.032));
  context.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const padding = Math.round(size * 0.6);
  const lineHeight = Math.round(size * 1.3);
  const width = Math.min(canvas.width, Math.max(...lines.map((line) => context.measureText(line).width)) + padding * 2);
  const height = lines.length * lineHeight + padding * 2 - (lineHeight - size);
  context.fillStyle = "rgba(0,0,0,0.6)";
  context.fillRect(0, canvas.height - height, width, height);
  context.fillStyle = "#ffffff";
  context.textBaseline = "top";
  lines.forEach((line, index) => context.fillText(line, padding, canvas.height - height + padding + index * lineHeight, width - padding * 2));
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("Não foi possível gravar a foto.");
  return blob;
}
