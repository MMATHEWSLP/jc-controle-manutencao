// Roda todas as suítes "test:*" do package.json (menos as que precisam de banco) uma a uma, mesmo
// que alguma falhe, e mostra um resumo no fim. Sai com erro se qualquer suíte falhar.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NEEDS_DATABASE = new Set(["test:stock"]);
const scripts = Object.keys(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts)
  .filter((name) => name.startsWith("test:") && !NEEDS_DATABASE.has(name));
const failed = [];
for (const name of scripts) {
  const result = spawnSync("npm", ["run", "-s", name], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) failed.push(name);
}
console.log(`\n${scripts.length - failed.length}/${scripts.length} suítes passaram.${failed.length ? ` Falharam: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
