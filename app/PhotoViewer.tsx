"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- fotos servidas por rota própria com permissão (link temporário) */
// Foto com zoom da aprovação do comboio: começa SEMPRE INTEIRA (contain), com zoom (botões, roda do
// mouse, pinça) e arrasto a partir da foto inteira; "Ajustar" volta para a foto inteira. Tocar na
// foto abre a tela cheia dentro da página (zoom, arrasto, girar 90°, setas entre as fotos, Esc/X).
// A orientação vem da informação EXIF da foto (image-orientation: from-image no CSS).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { fittedView, imageTransform, nextRotation, panBy, stageHeight, zoomAround, clampView, type Point, type Rotation, type Size, type View } from "../lib/photo-view";

export type PhotoItem = { src: string; label: string };

const STEP = 1.5;
const TAP_TOLERANCE = 6;

type Gesture =
  | { kind: "pan"; start: Point; view: View; moved: boolean }
  | { kind: "pinch"; distance: number; middle: Point; view: View };

// Estado e gestos da área da foto (usado na aprovação e na tela cheia). A área (boxRef) é de quem chama.
function usePhotoStage(boxRef: RefObject<HTMLDivElement | null>, rotation: Rotation, onTap?: () => void) {
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ box, natural, view, rotation, onTap });
  useLayoutEffect(() => { latest.current = { box, natural, view, rotation, onTap }; });

  useEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); setBox((current) => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }); };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [boxRef]);

  // Área ou foto mudou: na foto inteira, recentraliza; com zoom, só mantém dentro da área.
  useEffect(() => {
    if (!natural || !box.width || !box.height) return;
    setView((current) => current.zoom <= 1 ? fittedView(box) : clampView(current, box, natural, rotation));
  }, [box, natural, rotation]);

  const fit = useCallback(() => { const { box: area } = latest.current; setView(fittedView(area)); }, []);
  const zoomBy = useCallback((factor: number, point?: Point) => {
    const { box: area, natural: size, view: current, rotation: turn } = latest.current;
    if (!size || !area.width) return;
    setView(zoomAround(current, current.zoom * factor, point ?? { x: area.width / 2, y: area.height / 2 }, area, size, turn));
  }, []);

  // Roda do mouse: listener nativo (não passivo) para a página não rolar junto.
  useEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [boxRef, zoomBy]);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = boxRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const startGesture = () => {
    const points = [...pointers.current.values()];
    const { view: current } = latest.current;
    if (points.length >= 2) {
      const [a, b] = points;
      gesture.current = { kind: "pinch", distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: current };
    } else if (points.length === 1) {
      gesture.current = { kind: "pan", start: points[0], view: current, moved: gesture.current?.kind === "pinch" };
    } else gesture.current = null;
  };
  const handlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pointers.current.set(event.pointerId, local(event));
      startGesture();
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, local(event));
      const current = gesture.current;
      const { box: area, natural: size, rotation: turn } = latest.current;
      if (!current || !size) return;
      if (current.kind === "pinch") {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoomed = zoomAround(current.view, current.view.zoom * (distance / current.distance), current.middle, area, size, turn);
        setView(panBy(zoomed, middle.x - current.middle.x, middle.y - current.middle.y, area, size, turn));
        return;
      }
      const point = pointers.current.get(event.pointerId)!;
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) > TAP_TOLERANCE) current.moved = true;
      if (current.moved && current.view.zoom > 1) setView(panBy(current.view, dx, dy, area, size, turn));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!pointers.current.delete(event.pointerId)) return;
      const ended = gesture.current;
      if (pointers.current.size === 0) {
        gesture.current = null;
        if (ended?.kind === "pan" && !ended.moved) latest.current.onTap?.();
      } else startGesture();
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      gesture.current = null;
      if (pointers.current.size) startGesture();
    },
  };

  const imageStyle = natural && box.width ? {
    width: natural.width, height: natural.height, marginLeft: -natural.width / 2, marginTop: -natural.height / 2,
    transform: imageTransform(view, box, natural, rotation),
  } : { visibility: "hidden" as const };
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (image.naturalWidth && image.naturalHeight) setNatural({ width: image.naturalWidth, height: image.naturalHeight });
  };
  return { box, natural, view, fit, zoomBy, handlers, imageStyle, onLoad };
}

// Foto dentro da tela de aprovação: largura da coluna, altura até ~70% da tela, sempre inteira.
export function PhotoZoom({ src, alt, onExpand }: { src: string; alt: string; onExpand?: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stage = usePhotoStage(boxRef, 0, onExpand);
  const [viewport, setViewport] = useState(800);
  useEffect(() => {
    const read = () => setViewport(window.innerHeight || 800);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  const [failed, setFailed] = useState(false);
  const height = stageHeight(stage.box.width, stage.natural, viewport);
  return <div className="photo-zoom">
    <div ref={boxRef} className={`photo-stage${stage.view.zoom > 1 ? " zoomed" : ""}`} style={{ height }} {...stage.handlers}
      title={onExpand ? "Toque para abrir em tela cheia · roda do mouse ou pinça para zoom" : undefined}>
      {failed ? <span className="photo-stage-error">Não foi possível carregar a foto.</span>
        : <img src={src} alt={alt} draggable={false} onLoad={stage.onLoad} onError={() => setFailed(true)} style={stage.imageStyle} />}
    </div>
    <div className="convoy-zoom-controls">
      <button type="button" className="secondary" onClick={() => stage.zoomBy(STEP)} aria-label="Aumentar zoom">＋ Zoom</button>
      <button type="button" className="secondary" onClick={() => stage.zoomBy(1 / STEP)} aria-label="Diminuir zoom">－</button>
      <button type="button" className="secondary" onClick={stage.fit}>Ajustar</button>
      {onExpand && <button type="button" className="secondary" onClick={onExpand}>⛶ Tela cheia</button>}
      <a className="photo-new-tab" href={src} target="_blank" rel="noopener noreferrer">Abrir em nova aba</a>
    </div>
  </div>;
}

// Tela cheia dentro da própria página (por cima de tudo).
export function PhotoLightbox({ photos, start, onClose }: { photos: PhotoItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), photos.length - 1));
  const photo = photos[index];
  const go = useCallback((step: number) => setIndex((current) => (current + step + photos.length) % photos.length), [photos.length]);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  if (!photo || typeof document === "undefined") return null;
  return createPortal(<div className="photo-fullscreen" role="dialog" aria-modal="true" aria-label="Foto em tela cheia">
    <LightboxPhoto key={photo.src} photo={photo} index={index} total={photos.length} go={go} close={() => closeRef.current()} />
  </div>, document.body);
}

function LightboxPhoto({ photo, index, total, go, close }: { photo: PhotoItem; index: number; total: number; go: (step: number) => void; close: () => void }) {
  const [rotation, setRotation] = useState<Rotation>(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const stage = usePhotoStage(boxRef, rotation);
  const { fit, zoomBy } = stage;
  const [failed, setFailed] = useState(false);
  const rotate = useCallback(() => { setRotation(nextRotation); fit(); }, [fit]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        Escape: close, ArrowLeft: () => go(-1), ArrowRight: () => go(1),
        "+": () => zoomBy(STEP), "=": () => zoomBy(STEP), "-": () => zoomBy(1 / STEP), "0": fit, r: rotate, R: rotate,
      };
      const action = keys[event.key];
      if (!action || (total < 2 && (event.key === "ArrowLeft" || event.key === "ArrowRight"))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [close, go, rotate, fit, zoomBy, total]);

  return <>
    <header className="photo-fullscreen-bar">
      <strong>{photo.label}{total > 1 ? ` · ${index + 1}/${total}` : ""}</strong>
      <div>
        <button type="button" onClick={() => stage.zoomBy(1 / STEP)} aria-label="Diminuir zoom">－</button>
        <button type="button" onClick={() => stage.zoomBy(STEP)} aria-label="Aumentar zoom">＋</button>
        <button type="button" onClick={stage.fit}>Ajustar</button>
        <button type="button" onClick={rotate} aria-label="Girar 90 graus">⟳ Girar 90°</button>
        <a href={photo.src} target="_blank" rel="noopener noreferrer">Abrir em nova aba</a>
        <button type="button" className="photo-fullscreen-close" onClick={close} aria-label="Fechar">✕</button>
      </div>
    </header>
    <div className="photo-fullscreen-body">
      <div ref={boxRef} className={`photo-stage photo-fullscreen-stage${stage.view.zoom > 1 ? " zoomed" : ""}`} {...stage.handlers}>
        {failed ? <span className="photo-stage-error">Não foi possível carregar a foto.</span>
          : <img src={photo.src} alt={photo.label} draggable={false} onLoad={stage.onLoad} onError={() => setFailed(true)} style={stage.imageStyle} />}
      </div>
      {total > 1 && <>
        <button type="button" className="photo-fullscreen-nav prev" onClick={() => go(-1)} aria-label="Foto anterior">‹</button>
        <button type="button" className="photo-fullscreen-nav next" onClick={() => go(1)} aria-label="Próxima foto">›</button>
      </>}
    </div>
  </>;
}
