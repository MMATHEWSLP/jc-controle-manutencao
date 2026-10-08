// Foto da aprovação do comboio (lib/photo-view.ts): começa inteira (contain) e centralizada, zoom
// e arrasto partem dela e a foto nunca sai da área.
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ZOOM, clampView, fitScale, fittedView, imageTransform, nextRotation, panBy, rotatedSize, stageHeight, zoomAround } from "../lib/photo-view.ts";

const box = { width: 600, height: 500 };
const portrait = { width: 960, height: 1280 };
const landscape = { width: 1280, height: 720 };

test("foto inteira: em pé e deitada cabem sem corte", () => {
  const p = fitScale(box, portrait);
  assert.ok(portrait.width * p <= box.width + 1e-9 && portrait.height * p <= box.height + 1e-9);
  assert.equal(Math.round(portrait.height * p), 500); // a altura manda na foto em pé
  const l = fitScale(box, landscape);
  assert.equal(Math.round(landscape.width * l), 600); // a largura manda na foto deitada
  assert.ok(landscape.height * l <= box.height);
});

test("girar 90° troca largura e altura e a foto continua inteira", () => {
  assert.deepEqual(rotatedSize(landscape, 90), { width: 720, height: 1280 });
  assert.deepEqual(rotatedSize(landscape, 180), landscape);
  const scale = fitScale(box, landscape, 90);
  assert.ok(720 * scale <= box.width && 1280 * scale <= box.height + 1e-9);
  assert.equal(nextRotation(0), 90);
  assert.equal(nextRotation(270), 0);
});

test("visualização inicial e Ajustar: centralizada, zoom 1", () => {
  assert.deepEqual(fittedView(box), { zoom: 1, x: 300, y: 250 });
  assert.equal(imageTransform(fittedView(box), box, portrait), `translate(300px, 250px) rotate(0deg) scale(${Math.round(fitScale(box, portrait) * 1e5) / 1e5})`);
});

test("zoom no ponto do cursor mantém aquele ponto parado", () => {
  const start = fittedView(box);
  const point = { x: 400, y: 300 };
  const zoomed = zoomAround(start, 2, point, box, landscape);
  assert.equal(zoomed.zoom, 2);
  // O ponto da foto embaixo do cursor continua embaixo do cursor.
  const before = { x: (point.x - start.x) / (fitScale(box, landscape) * start.zoom), y: (point.y - start.y) / (fitScale(box, landscape) * start.zoom) };
  const after = { x: (point.x - zoomed.x) / (fitScale(box, landscape) * zoomed.zoom), y: (point.y - zoomed.y) / (fitScale(box, landscape) * zoomed.zoom) };
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  // Na vertical a foto (337,5 px × 2 = 675 > 500) passou a ocupar a área toda: pode ser preciso encostar a borda.
  assert.ok(zoomed.y - (720 * fitScale(box, landscape) * 2) / 2 <= 0 && zoomed.y + (720 * fitScale(box, landscape) * 2) / 2 >= box.height);
});

test("zoom tem limites; voltar a 1 recentraliza", () => {
  const start = fittedView(box);
  assert.equal(zoomAround(start, 100, { x: 0, y: 0 }, box, portrait).zoom, MAX_ZOOM);
  const back = zoomAround(zoomAround(start, 3, { x: 10, y: 10 }, box, portrait), 0.2, { x: 10, y: 10 }, box, portrait);
  assert.deepEqual(back, fittedView(box));
});

test("arrastar: sem zoom não mexe; com zoom as bordas não descolam", () => {
  const start = fittedView(box);
  assert.deepEqual(panBy(start, 200, 200, box, portrait), start);
  const zoomed = zoomAround(start, 4, { x: 300, y: 250 }, box, portrait);
  const far = panBy(zoomed, 10_000, -10_000, box, portrait);
  const scale = fitScale(box, portrait) * 4;
  assert.equal(far.x, (portrait.width * scale) / 2); // borda esquerda da foto encostada na esquerda da área
  assert.equal(far.y, box.height - (portrait.height * scale) / 2); // borda de baixo encostada embaixo
});

test("clampView centraliza o eixo em que a foto é menor que a área", () => {
  const view = clampView({ zoom: 1.2, x: 0, y: 0 }, box, portrait);
  assert.equal(view.x, 300); // 960 × 0,39 × 1,2 = 450 < 600 → centralizada na horizontal
});

test("altura da área: acompanha a proporção, até 70% da tela", () => {
  assert.equal(stageHeight(600, landscape, 900), 338); // deitada: 600 × 720/1280
  assert.equal(stageHeight(600, portrait, 900), 630); // em pé: limitada a 70% de 900
  assert.equal(stageHeight(600, null, 900), 450); // antes de carregar: 4:3
  assert.equal(stageHeight(100, landscape, 900), 180); // mínimo legível
});
