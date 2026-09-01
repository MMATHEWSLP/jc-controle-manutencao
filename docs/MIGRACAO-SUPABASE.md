# Migração: Cloudflare (D1/Workers) → Postgres/Supabase

## Por que migrar

O projeto foi exportado do ChatGPT Sites, que roda sobre Cloudflare Workers
com banco D1 (SQLite) e variáveis de ambiente injetadas pela própria
Cloudflare. Ele não rodava fora desse ambiente: o login falhava porque a
senha inicial do administrador e a conexão com o banco só existiam dentro da
Cloudflare. Uma tentativa anterior de publicar isso na Hostinger só
resolveu o erro de "diretório de saída não encontrado", mas não o problema
de fundo.

Em vez de tentar rodar isso na Hostinger com um banco SQLite local (viável,
mas um sistema paralelo ao JC SISTEMA), a decisão foi migrar direto para
Postgres no Supabase e este projeto se tornar um módulo do JC SISTEMA.

## O que foi alterado

### 1. `db/schema.ts` — schema convertido para Postgres
Todas as 33 tabelas foram convertidas de `drizzle-orm/sqlite-core` para
`drizzle-orm/pg-core`. Principais decisões de conversão:

- IDs numéricos autoincrementados (`integer autoincrement`) → `serial`
- Campos booleanos (guardados como `0`/`1` no SQLite) → `boolean` nativo do
  Postgres. Isso é seguro porque o código já lê esses campos com
  `Number(valor)===1`, que funciona tanto para `0`/`1` quanto para `true`/`false`.
- Campos numéricos (`real`) → `doublePrecision` (equivalente ao `REAL` de
  8 bytes do SQLite, evita perda de precisão)
- Datas continuam como `text` (strings ISO 8601), e não colunas de data
  nativas do Postgres — para não precisar alterar toda a lógica de
  comparação/formatação de datas espalhada pelo código, que já assume texto.
- IDs que já eram texto (UUIDs gerados no próprio código) continuam como
  `text` — sem necessidade de virar `uuid` nativo agora.

### 2. `db/index.ts` — nova camada de conexão
O arquivo original pedia a conexão D1 direto da Cloudflare
(`import("cloudflare:workers")`). A nova versão conecta no Postgres do
Supabase via `pg`, mas **mantém exatamente a mesma "casca"** que as ~19
rotas da API já usam (`d1.prepare(sql).bind(...).all()/.first()/.run()`,
`d1.batch([...])`). Por isso, praticamente nenhuma rota precisou ser
reescrita — só o "motor" por trás foi trocado.

Detalhes técnicos dessa camada de compatibilidade:
- Converte `?` (estilo SQLite) para `$1, $2, ...` (estilo Postgres)
  automaticamente, com cuidado para não mexer em `?` dentro de textos entre aspas.
- `batch()` roda tudo dentro de uma transação real do Postgres (`BEGIN`/`COMMIT`/`ROLLBACK`).

### 3. Ajustes de sintaxe SQL específicos do SQLite
Apenas 5 pontos no código usavam sintaxe exclusiva do SQLite:
- `lib/whatsapp.ts`: `INSERT OR IGNORE` → `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING`
- `app/api/fleet-status/route.ts` e `app/api/fleet-status-report-pdf/route.ts`
  (4 ocorrências): `GROUP_CONCAT(...)` → `STRING_AGG(...)` (equivalente no Postgres)

### 4. Variáveis de ambiente
`lib/auth.ts` e `lib/whatsapp.ts` liam configuração via
`import("cloudflare:workers")`. Agora leem de `process.env` normalmente
(`INITIAL_ADMIN_PASSWORD`, `WHATSAPP_*`) — variáveis de ambiente padrão de
qualquer hospedagem Node.js.

### 5. Build e dependências
- Removidos: `vinext`, `wrangler`, `@cloudflare/vite-plugin`, `vite` e
  arquivos ligados a isso (`worker/index.ts`, `vite.config.ts`,
  `build/sites-vite-plugin.ts`, pasta `.vinext/`, `.openai/hosting.json`).
- Adicionados: `pg` (driver Postgres) e `@types/pg`.
- `npm run build` agora roda o `next build` padrão (antes era um script que
  compilava com o vinext e depois "disfarçava" a saída para enganar o
  detector de build da Hostinger).
- `drizzle.config.ts` agora aponta para `dialect: "postgresql"` usando
  `DATABASE_URL`.
- As migrations antigas em `drizzle/*.sql` (geradas para SQLite) foram
  removidas — rode `npm run db:generate` para gerar a migration inicial em
  cima do novo schema Postgres, depois `npm run db:migrate` para aplicá-la
  no Supabase.

## O que ficou pendente / decisão consciente

**Login não unificado com o Supabase Auth.** Você optou por manter o sistema
de login próprio deste módulo (tabela `users`, senha com hash PBKDF2, sessão
por cookie assinado) em vez de migrar para o Supabase Auth que o restante do
JC SISTEMA já usa. Isso significa, por enquanto:

- Duas telas de login diferentes (uma para o JC SISTEMA "geral", outra para
  este módulo de manutenção).
- Dois cadastros de usuário separados — um usuário criado num sistema não
  aparece automaticamente no outro.
- As permissões deste módulo (`equipment.view`, `fleet.update` etc., em
  `lib/auth.ts`) são independentes das permissões do restante do JC SISTEMA.

Se no futuro quiser unificar os logins, o caminho é: (1) apontar este módulo
para o Supabase Auth, (2) migrar a tabela `users` para virar `profiles`
ligada a `auth.users`, (3) mapear as permissões deste módulo para o sistema
de permissões do JC SISTEMA. É um trabalho considerável — melhor tratado
como uma etapa própria, não em cima da migração de banco.

## O que NÃO foi testado (sem acesso a um Postgres real neste ambiente)

Esta migração foi feita por leitura e análise cuidadosa do código-fonte, mas
**não pôde ser executada/testada de fato** contra um banco Postgres real
(sem acesso à internet neste ambiente). Antes de considerar isso pronto para
produção, valide especialmente:

1. `npm install` completa sem erros.
2. `npm run db:generate` gera uma migration Postgres coerente.
3. `npm run db:migrate` aplica sem erro no Supabase.
4. Login funciona com o usuário administrador inicial.
5. Fluxos que usam `d1.batch(...)` (leituras de horímetro/KM, manutenções,
   transferências) — a lógica de transação foi escrita mas precisa ser
   testada de ponta a ponta.
6. Geração de PDFs e importação de Excel (não tocamos nessa lógica, mas
   dependem indiretamente do banco).
7. Envio de WhatsApp, se for usar essa função.

## Próximos passos sugeridos

1. Criar um projeto Supabase (se ainda não usar o mesmo do JC SISTEMA) e
   pegar a `DATABASE_URL`.
2. Rodar `npm install`, `npm run db:generate`, `npm run db:migrate` localmente.
3. Testar login e os principais fluxos localmente (`npm run dev`).
4. Publicar (Vercel, junto com o JC SISTEMA, ou onde preferir).
5. Decidir e planejar a unificação de login, se/quando fizer sentido.
