import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";

// Regressão do erro 42P18 "could not determine data type of parameter":
// um placeholder "?" usado NUA (sem cast) diretamente antes de "IS NULL"/
// "IS NOT NULL" faz o driver do Postgres falhar ao inferir o tipo do
// parâmetro quando o valor bindado é NULL, porque não há nenhuma outra
// pista de tipo no resto da query (diferente de "coluna=?" ou
// "COALESCE(coluna,?)", onde o tipo vem do outro lado da expressão).
// Aconteceu em app/api/fleet-status/route.ts ("closed_by=CASE WHEN ? IS
// NOT NULL THEN ? ..."), quebrando qualquer abertura/continuação de
// ocorrência de Status da Frota para TODO equipamento, não só os
// importados. Corrigido com um cast explícito ("?::text IS NOT NULL").
//
// Este teste varre app/ e lib/ inteiros por esse padrão perigoso, pra não
// deixar reaparecer em nenhuma query nova.

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["app", "lib"];
const DANGEROUS_PATTERN = /\?(?!:)\s+IS\s+(NOT\s+)?NULL\b/;

function listTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) files.push(...listTsFiles(full));
    else if (extname(entry) === ".ts" || extname(entry) === ".tsx") files.push(full);
  }
  return files;
}

test("regex de deteccao reconhece o padrao perigoso e ignora o corrigido (sanity check)", () => {
  assert.equal(DANGEROUS_PATTERN.test("closed_by=CASE WHEN ? IS NOT NULL THEN ? ELSE closed_by END"), true);
  assert.equal(DANGEROUS_PATTERN.test("closed_by=CASE WHEN ?::text IS NOT NULL THEN ? ELSE closed_by END"), false);
  assert.equal(DANGEROUS_PATTERN.test("status IS NULL"), false); // literal, não parâmetro — sempre válido
  assert.equal(DANGEROUS_PATTERN.test("service_front_id IS NOT DISTINCT FROM ?"), false); // outro padrão, já coberto por outro teste
});

test("nenhuma query em app/ ou lib/ usa '? IS NULL' / '? IS NOT NULL' sem cast explícito (erro 42P18)", () => {
  const achados = [];
  for (const dir of SCAN_DIRS) {
    for (const file of listTsFiles(join(ROOT, dir))) {
      const content = readFileSync(file, "utf8");
      if (DANGEROUS_PATTERN.test(content)) achados.push(file.replace(ROOT, ""));
    }
  }
  assert.deepEqual(achados, [], `Encontrado "? IS [NOT] NULL" sem cast em: ${achados.join(", ")}`);
});
