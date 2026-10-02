// Copia docs/manual-assistente.md para lib/assistente/manual-texto.ts (o build standalone do Next.js
// só leva o que é importado; ler o .md do disco em tempo de execução quebraria no servidor).
// Rode depois de editar o manual: node scripts/gerar-manual-assistente.mjs
// (tests/assistente-rules.test.mjs falha se os dois estiverem diferentes).
import { readFileSync, writeFileSync } from "node:fs";

const markdown = readFileSync(new URL("../docs/manual-assistente.md", import.meta.url), "utf8");
writeFileSync(new URL("../lib/assistente/manual-texto.ts", import.meta.url),
  `// Gerado por scripts/gerar-manual-assistente.mjs a partir de docs/manual-assistente.md — não edite aqui.\nexport const MANUAL_ASSISTENTE = ${JSON.stringify(markdown)};\n`);
console.log("lib/assistente/manual-texto.ts atualizado.");
