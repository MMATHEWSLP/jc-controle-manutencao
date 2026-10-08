// ---------------------------------------------------------------------------
// Visualização de foto com zoom (aprovação do comboio). A foto começa SEMPRE INTEIRA ("contain") e
// centralizada na área; zoom e arrasto partem dessa visualização e nunca deixam a foto sair da área.
// Funções puras (sem tela) — testadas em tests/photo-view.test.mjs.
//
// zoom = 1 é a foto inteira; x/y = onde fica o CENTRO da foto dentro da área, em pixels.
// ---------------------------------------------------------------------------
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type View = { zoom: number; x: number; y: number };
export type Rotation = 0 | 90 | 180 | 270;

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : MIN_ZOOM));

export function nextRotation(rotation: Rotation): Rotation {
  return ((rotation + 90) % 360) as Rotation;
}

// Girada de 90° ou 270°, a foto "deitada" troca largura por altura.
export function rotatedSize(natural: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: natural.height, height: natural.width } : natural;
}

// Escala que faz a foto inteira caber na área (nunca corta).
export function fitScale(box: Size, natural: Size, rotation: Rotation = 0) {
  const shown = rotatedSize(natural, rotation);
  if (!(box.width > 0 && box.height > 0 && shown.width > 0 && shown.height > 0)) return 1;
  return Math.min(box.width / shown.width, box.height / shown.height);
}

export function fittedView(box: Size): View {
  return { zoom: 1, x: box.width / 2, y: box.height / 2 };
}

// Mantém a foto dentro da área: menor que a área → centralizada; maior → as bordas não descolam.
export function clampView(view: View, box: Size, natural: Size, rotation: Rotation = 0): View {
  const zoom = clampZoom(view.zoom);
  const scale = fitScale(box, natural, rotation) * zoom;
  const shown = rotatedSize(natural, rotation);
  const axis = (position: number, length: number, room: number) =>
    length <= room ? room / 2 : Math.min(length / 2, Math.max(room - length / 2, position));
  return { zoom, x: axis(view.x, shown.width * scale, box.width), y: axis(view.y, shown.height * scale, box.height) };
}

// Zoom mantendo parado o ponto da foto que está embaixo do cursor/dedos.
export function zoomAround(view: View, nextZoom: number, point: Point, box: Size, natural: Size, rotation: Rotation = 0): View {
  const zoom = clampZoom(nextZoom);
  if (zoom === MIN_ZOOM) return fittedView(box);
  const ratio = zoom / view.zoom;
  return clampView({ zoom, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, box, natural, rotation);
}

export function panBy(view: View, dx: number, dy: number, box: Size, natural: Size, rotation: Rotation = 0): View {
  return clampView({ zoom: view.zoom, x: view.x + dx, y: view.y + dy }, box, natural, rotation);
}

// Transformação CSS da imagem desenhada no tamanho natural com o centro no canto da área
// (left/top 0, margens negativas de meia largura/altura, transform-origin no centro).
export function imageTransform(view: View, box: Size, natural: Size, rotation: Rotation = 0) {
  const scale = fitScale(box, natural, rotation) * view.zoom;
  return `translate(${round(view.x)}px, ${round(view.y)}px) rotate(${rotation}deg) scale(${round(scale, 5)})`;
}

// Altura da área da foto na tela da aprovação: a largura da coluna manda; a altura acompanha a
// proporção da foto, limitada a uma fração da altura da tela (ex.: 70%) e a um mínimo legível.
export function stageHeight(width: number, natural: Size | null, viewportHeight: number, fraction = 0.7, minimum = 180) {
  const limit = Math.max(minimum, Math.round(viewportHeight * fraction));
  const ratio = natural && natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 3 / 4;
  return Math.max(minimum, Math.min(limit, Math.round(width * ratio)));
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
