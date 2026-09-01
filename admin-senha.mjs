import "dotenv/config";
import pg from "pg";

// Uso:
//   node admin-senha.mjs                  -> mostra o usuario e testa senhas candidatas
//   node admin-senha.mjs "NovaSenha123"   -> redefine a senha do mathews para essa

const PASSWORD_ITERATIONS = 100_000;

// Senhas que vamos testar contra o hash guardado no banco.
const CANDIDATAS = ["Mateusbiro2026", "Mateus@9114", "Mateusbiro%409114", "Mateusbiro9114"];

function bytesParaHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function gerarHash(senha, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(senha),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: PASSWORD_ITERATIONS,
    },
    material,
    256
  );
  return bytesParaHex(new Uint8Array(bits));
}

function novoSalt() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

const novaSenha = process.argv[2];
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL nao encontrada no .env");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

try {
  const { rows } = await pool.query(
    'select id, email, name, username, role, status, is_primary_admin, password_salt, password_hash, password_updated_at from "users" order by id'
  );

  if (rows.length === 0) {
    console.log("Nenhum usuario cadastrado na tabela users.");
    process.exit(0);
  }

  console.log("USUARIOS CADASTRADOS:");
  for (const u of rows) {
    console.log(
      `  id=${u.id}  username=${u.username}  email=${u.email}  role=${u.role}  status=${u.status}  admin=${u.is_primary_admin}`
    );
    console.log(`     senha definida em: ${u.password_updated_at}`);
    console.log(`     tem hash: ${Boolean(u.password_hash)}   tem salt: ${Boolean(u.password_salt)}`);
  }

  const admin = rows.find((u) => u.username === "mathews") ?? rows[0];

  console.log("-".repeat(70));
  console.log(`TESTANDO SENHAS CONTRA O HASH DE "${admin.username}":`);

  if (!admin.password_hash || !admin.password_salt) {
    console.log("  Usuario esta SEM hash/salt - nenhuma senha vai funcionar.");
  } else {
    for (const candidata of CANDIDATAS) {
      const hash = await gerarHash(candidata, admin.password_salt);
      const bate = hash === admin.password_hash;
      console.log(`  ${bate ? "CONFERE  ->" : "nao bate   "} ${candidata}`);
    }
  }

  if (novaSenha) {
    console.log("-".repeat(70));
    const salt = novoSalt();
    const hash = await gerarHash(novaSenha, salt);
    const agora = new Date().toISOString();
    await pool.query(
      'update "users" set password_hash = $1, password_salt = $2, password_updated_at = $3, updated_at = $3, status = $4, role = $5, is_primary_admin = true where id = $6',
      [hash, salt, agora, "ACTIVE", "ADMIN", admin.id]
    );
    await pool.query('delete from "user_sessions" where user_id = $1', [admin.id]);
    console.log(`SENHA REDEFINIDA para o usuario "${admin.username}".`);
    console.log("Sessoes antigas removidas. Ja pode logar com a senha nova.");
  }
} catch (erro) {
  console.log("-".repeat(70));
  console.error("ERRO:", erro.message, erro.code ?? "");
} finally {
  await pool.end();
}
