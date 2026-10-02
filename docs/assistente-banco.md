# Assistente JC — acesso ao banco (somente leitura)

O Assistente JC consulta o sistema por meio das views do schema `assistente` (migração `drizzle/0038_assistente_views.sql`).
Ele usa uma conexão própria, `ASSISTANT_DATABASE_URL`, com o usuário `assistente_leitura`. Esse usuário:

- só tem `USAGE` no schema `assistente`, `SELECT` nas views e `EXECUTE` nas funções `assistente.dia` e `assistente.chave`;
- não tem nenhum acesso às tabelas de `public` (usuários, senhas, sessões, tokens, WhatsApp etc.);
- tem `default_transaction_read_only = on`, `statement_timeout = 20s` e `search_path = assistente`.

Além disso, toda consulta do assistente roda dentro de `BEGIN READ ONLY ... ROLLBACK`. Mesmo com um erro de código, ele não consegue gravar nada.

## 1. Ativar o usuário (uma vez só)

A migração cria o papel `assistente_leitura` **sem login**. Para ativar:

1. No Supabase, abra **SQL Editor** e rode o comando abaixo, trocando a senha por uma forte (só letras e números, para não precisar codificar na URL):

   ```sql
   ALTER ROLE assistente_leitura WITH LOGIN PASSWORD 'TROQUE_POR_UMA_SENHA_FORTE';
   ```

2. Em **Project Settings → Database → Connection string**, copie a URL do **Session pooler** (porta 5432). Troque o usuário `postgres.<ref>` por `assistente_leitura.<ref>` e coloque a senha do passo 1:

   ```
   postgresql://assistente_leitura.<ref-do-projeto>:<senha>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
   ```

   O `<ref-do-projeto>` é o mesmo que aparece no usuário da `DATABASE_URL` atual (`postgres.<ref>`). O host também é o mesmo da `DATABASE_URL`.

3. Cadastre a variável **`ASSISTANT_DATABASE_URL`** com essa URL:
   - na **Hostinger** (variáveis de ambiente da aplicação Node), e reinicie/reimplante a aplicação;
   - opcionalmente, em **GitHub → Settings → Secrets and variables → Actions**, com o mesmo nome. Assim o workflow "Testar Assistente JC" testa com o usuário somente leitura.

Enquanto `ASSISTANT_DATABASE_URL` não existir, o assistente usa a `DATABASE_URL` principal, mas sempre em transação `READ ONLY`. Para o ADMIN, o painel do assistente avisa quando está nesse modo.

## 2. Conferir

No SQL Editor:

```sql
SET ROLE assistente_leitura;
SELECT count(*) FROM assistente.v_equipamentos;   -- funciona
SELECT count(*) FROM public.users;                -- ERRO: permission denied
RESET ROLE;
```

No GitHub, rode **Actions → Testar Assistente JC**. O resultado sai no log e também no artefato `resultado-assistente-N`:

- as 10 perguntas de referência, como ADMIN e como um usuário de uma frente só;
- a conferência de que esse usuário não vê outras frentes;
- as respostas completas do assistente, se o secret `ANTHROPIC_API_KEY` existir.

## 3. Manutenção

- **Nova view:** crie a view numa migração nova, no schema `assistente`. Depois:
  - repita o `GRANT SELECT ON ALL TABLES IN SCHEMA assistente TO assistente_leitura` (os grants não valem para views criadas depois);
  - descreva a view em `lib/assistente/catalogo.ts`; o teste `npm run test:assistente-consulta` confere o catálogo com as views da migração.
- **Nunca coloque nas views:** senhas, hashes, tokens, chaves, QR tokens, sessões, configurações de WhatsApp, CPF, data de nascimento ou salário.
- **Manual:** o manual que o assistente consulta (`ajuda_sistema`) é `docs/manual-assistente.md`. Depois de editar, rode:

  ```
  node scripts/gerar-manual-assistente.mjs
  ```

  Esse comando atualiza `lib/assistente/manual-texto.ts`, que vai junto no build.
- **Trocar a senha:** rode `ALTER ROLE assistente_leitura WITH PASSWORD '...'` e atualize `ASSISTANT_DATABASE_URL` na Hostinger.
- **Desligar o acesso:** rode `ALTER ROLE assistente_leitura NOLOGIN`. O assistente passa a falhar nas consultas, sem afetar o resto do sistema.
