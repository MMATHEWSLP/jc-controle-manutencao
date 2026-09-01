# Controle de Manutenção Preventiva (módulo do JC SISTEMA)

Sistema de gestão de frota, manutenção preventiva, status da frota e alertas
por WhatsApp para a JC Serviços Florestais.

## Histórico desta versão

Este projeto foi originalmente gerado via ChatGPT Sites, rodando sobre
Cloudflare Workers + banco D1 (SQLite). Ele foi migrado para rodar como um
projeto **Next.js padrão** com banco **Postgres no Supabase**, para se
integrar ao JC SISTEMA. Não há mais nenhuma dependência da Cloudflare no
código (`cloudflare:workers`, D1, R2, `vinext`, `wrangler` foram removidos).

## Stack

- **Frontend/Backend:** Next.js 16 (App Router), TypeScript
- **Banco de dados:** PostgreSQL via Supabase, acessado com `pg` + `drizzle-orm`
- **Autenticação:** sistema próprio (usuário/senha na tabela `users`, sessão
  por cookie) — independente do Supabase Auth usado no restante do JC SISTEMA
- **Deploy:** qualquer host Node.js ≥ 20.9 (Vercel, Hostinger, VPS, etc.),
  usando a saída `output: "standalone"` do `next build`

## Variáveis de ambiente necessárias

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | Sim | Connection string do Postgres do Supabase (Project Settings → Database → Connection string → modo "Session" ou "Transaction pooler") |
| `INITIAL_ADMIN_PASSWORD` | Sim, no primeiro login | Senha do usuário administrador inicial (`mathews`), criado automaticamente no primeiro login |
| `WHATSAPP_ACCESS_TOKEN` | Só se usar WhatsApp | Token da API da Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | Só se usar WhatsApp | ID do número no WhatsApp Business |
| `WHATSAPP_API_VERSION` | Não | Padrão `v23.0` |
| `WHATSAPP_PUBLIC_BASE_URL` | Só se usar WhatsApp | URL pública do sistema (para webhooks) |
| `WHATSAPP_CRON_SECRET` | Só se usar WhatsApp automático | Segredo para autorizar a rotina de verificação periódica |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Só se usar WhatsApp | Usado na verificação do webhook da Meta |
| `WHATSAPP_APP_SECRET` | Só se usar WhatsApp | Segredo do app da Meta |
| `WHATSAPP_CREDENTIALS_ENCRYPTION_KEY` | Só se usar WhatsApp | Chave para criptografar o token salvo no banco |

## Como rodar pela primeira vez

```bash
npm install
npm run db:generate   # gera a migration inicial em drizzle/ a partir de db/schema.ts
npm run db:migrate    # aplica a migration no Postgres do Supabase (usa DATABASE_URL)
npm run build
npm start
```

No primeiro login, use o usuário `mathews` (e-mail `mathews@manutencao.local`)
com a senha definida em `INITIAL_ADMIN_PASSWORD`.

## O que NÃO veio nesta migração (propositalmente)

- Nenhum dado de produção (equipamentos, usuários, manutenções etc.) — o
  banco começa vazio, estrutura apenas.
- O sistema de login com Supabase Auth do restante do JC SISTEMA **não** foi
  unificado com este módulo — foi uma decisão consciente para acelerar a
  entrega. Ver `docs/MIGRACAO-SUPABASE.md` para detalhes e o que fica pendente.

## Estrutura

```
app/            páginas e rotas de API (App Router do Next.js)
db/schema.ts    schema do banco (Drizzle ORM, dialeto Postgres)
db/index.ts     conexão com o Postgres + camada de compatibilidade
lib/            regras de negócio (manutenção, frota, WhatsApp, PDF, Excel)
drizzle/        migrations geradas pelo drizzle-kit
docs/           notas da migração
```
