import "dotenv/config";
import pg from "pg";

// ---------------------------------------------------------------------------
// Valor do litro do diesel em estoque. O custo das saídas é calculado ao vivo (lib/fuel-rules.ts:
// computeFuelCosts) pela média ponderada do R$/L das ENTRADAS de cada estoque; entrada sem valor
// soma litros sem dar preço, e o estoque que nunca teve entrada com valor deixa as saídas "sem valor".
// Este script preenche o R$/L das entradas de diesel que estão SEM valor (inclusive as importadas e
// os ajustes de saldo); entradas que já têm valor não mudam. Todas as saídas passam a ter valor.
// Simula por padrão; só grava com --confirmar. Rodar de novo não muda nada (só pega entradas sem valor).
//
// Uso:
//   node scripts/valor-diesel-estoque.mjs --valor=6,38               (prévia, não grava)
//   node scripts/valor-diesel-estoque.mjs --valor=6,38 --confirmar   (grava)
// Para desfazer: o log lista os ids alterados e o SQL que volta o valor para vazio.
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const VALOR = Number(arg("valor").replace(/\./g, "").replace(",", "."));
if (!(VALOR > 0 && VALOR < 100)) { console.error(`--valor inválido ("${arg("valor")}"). Ex.: --valor=6,38`); process.exit(1); }

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }
const client = new pg.Client({ connectionString: url, ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false } });
const litros = (value) => `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const reais = (value) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 });

await client.connect();
try {
  const fuels = (await client.query(`SELECT id, name FROM fuel_types WHERE name ILIKE '%diesel%' ORDER BY name`)).rows;
  if (!fuels.length) { console.log("Nenhum combustível com \"diesel\" no nome."); process.exit(0); }
  console.log(`Combustíveis: ${fuels.map((fuel) => fuel.name).join(", ")} · valor do litro: ${reais(VALOR)}`);
  const fuelIds = fuels.map((fuel) => fuel.id);

  const base = `FROM fuel_movements m JOIN service_fronts f ON f.id = m.service_front_id JOIN fuel_types t ON t.id = m.fuel_type_id
    WHERE m.deleted_at IS NULL AND m.movement_type = 'ENTRADA' AND m.fuel_type_id = ANY($1)`;
  const semValor = (await client.query(`SELECT m.id, f.name AS frente, m.stock_location AS estoque, t.name AS combustivel, m.quantity, m.movement_date, m.balance_adjustment
    ${base} AND (m.unit_price IS NULL OR m.unit_price <= 0) ORDER BY f.name, m.stock_location, t.name, m.movement_date, m.id`, [fuelIds])).rows;
  const comValor = (await client.query(`SELECT f.name AS frente, m.stock_location AS estoque, t.name AS combustivel, m.unit_price, count(*)::int AS entradas, sum(m.quantity) AS litros
    ${base} AND m.unit_price > 0 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`, [fuelIds])).rows;

  console.log(`\nEntradas SEM valor que vão receber ${reais(VALOR)}/L: ${semValor.length}`);
  const grupos = new Map();
  for (const row of semValor) {
    const key = `${row.frente} · ${row.estoque === "PORTO" ? "Porto" : "Frente"} · ${row.combustivel}`;
    const grupo = grupos.get(key) ?? { entradas: 0, ajustes: 0, litros: 0, de: row.movement_date, ate: row.movement_date };
    grupo.entradas += 1; if (row.balance_adjustment) grupo.ajustes += 1; grupo.litros += Number(row.quantity);
    if (row.movement_date < grupo.de) grupo.de = row.movement_date; if (row.movement_date > grupo.ate) grupo.ate = row.movement_date;
    grupos.set(key, grupo);
  }
  for (const [key, grupo] of grupos) console.log(`  - ${key}: ${grupo.entradas} entrada(s)${grupo.ajustes ? ` (${grupo.ajustes} ajuste(s) de saldo)` : ""}, ${litros(grupo.litros)}, de ${grupo.de} a ${grupo.ate}`);

  console.log(`\nEntradas que JÁ têm valor (não mudam; entram na média do estoque): ${comValor.reduce((sum, row) => sum + row.entradas, 0)}`);
  for (const row of comValor) console.log(`  - ${row.frente} · ${row.estoque === "PORTO" ? "Porto" : "Frente"} · ${row.combustivel}: ${row.entradas} entrada(s) a ${reais(row.unit_price)}/L, ${litros(row.litros)}`);

  if (!semValor.length) { console.log("\nNada a fazer: todas as entradas de diesel já têm valor."); process.exit(0); }
  const ids = semValor.map((row) => row.id);
  if (!CONFIRMAR) { console.log("\nPRÉVIA: nada foi gravado. Rode com --confirmar para gravar."); process.exit(0); }

  await client.query("BEGIN");
  const { rowCount } = await client.query(`UPDATE fuel_movements SET unit_price = $1, updated_at = $2 WHERE id = ANY($3) AND (unit_price IS NULL OR unit_price <= 0)`, [VALOR, new Date().toISOString(), ids]);
  await client.query("COMMIT");
  console.log(`\nGRAVADO: ${rowCount} entrada(s) com ${reais(VALOR)}/L.`);
  console.log(`Ids alterados: ${ids.join(",")}`);
  console.log(`Para desfazer: UPDATE fuel_movements SET unit_price = NULL WHERE unit_price = ${VALOR} AND id IN (${ids.join(",")});`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
