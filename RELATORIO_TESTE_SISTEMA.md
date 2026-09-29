# Relatório de teste geral do Sistema JC

Data: 29/09/2026 · Código: branch `claude/wizardly-cannon-fgfqd8` (igual à `main` + scripts de auditoria) · Banco: produção (Supabase), **só leitura**

Nesta etapa **nada foi corrigido**. Os itens abaixo são para você escolher o que entra na próxima rodada.

## Como o teste foi feito

- **Verificações automáticas:** `npm run build`, `tsc --noEmit`, `eslint .`, `npm audit`, `npm outdated`, as 23 suítes de teste (uma a uma) e buscas no código.
- **Banco de produção:** consultas rodadas pelo script `auditoria-banco.mjs`, dentro de uma transação `READ ONLY`. O Postgres recusa qualquer gravação nesse modo, e o script termina com ROLLBACK. Ele rodou pelo workflow "Importar histórico de abastecimento", modo `auditoria-banco-somente-leitura`.
- **Telas:** o sistema subiu localmente (build de produção) com uma cópia de dados de teste. O Playwright navegou pelas 21 telas em desktop (1440 px) e celular (390 px), no tema claro e no escuro: 84 prints, mais uma medição automática de contraste de texto (WCAG). Os prints dos problemas estão em `docs/relatorio-teste-prints/`.
- **Permissões:** criei localmente um usuário OFICINA, restrito a uma frente, e chamei as APIs de administrador diretamente. Também revisei as 117 rotas de API.

## Resumo geral

| Prioridade | Itens |
|---|---|
| CRÍTICO | 2 |
| ALTO | 8 |
| MÉDIO | 22 |
| BAIXO | 35 |
| **Total** | **67** |

**Resultado das verificações automáticas**

- **Build:** passou.
- **Tipagem:** `tsc` sem erros.
- **Lint:** sem avisos.
- **Código esquecido:** nenhum `console.log`, `TODO` ou `FIXME` no código das telas e APIs.
- **Testes:** `npm test` quebra na 2ª suíte, e as outras 20 nunca rodam por esse comando. Rodando uma a uma, 21 de 22 passam (218 testes). As que falham:
  - `test:reconciliation`: está obsoleta.
  - `test:stock`: precisa de um banco de teste; ver item GER-01.
- **Dependências:** `npm audit` aponta 10 vulnerabilidades (1 crítica: `next`).

### As 5 coisas mais urgentes

1. **GER-01:** a variável `DATABASE_URL` do ambiente de desenvolvimento aponta para o banco de **produção**, e o teste `test:stock` grava dados de teste usando essa variável. Desta vez nada foi gravado, porque a conexão deu timeout (confirmei por consulta de leitura: 0 frentes de teste). Mesmo assim, o risco é real.
2. **SEG-01:** o login principal não tem limite de tentativas: 8 senhas erradas seguidas, nenhum bloqueio.
3. **GER-04:** o Next.js 16.2.6 tem vulnerabilidade crítica (desvio de middleware, DoS e SSRF). Atualizar para 16.3.7.
4. **EQP-01:** a "última troca" dos planos de óleo aparece **um dia antes** da data real.
5. **VIS-01:** no celular, o menu superior fica com os botões sobrepostos e cortados ("PAMENTO", "RODUTOS"). É a tela mais usada no campo.

---

## 1. Geral (build, testes, dependências, publicação)

**GER-01 · CRÍTICO · Segurança/Dados — teste que grava dados pode apontar para a produção**
- **Onde:** `tests/stock-service.integration.test.mjs:12` e o script `test:stock` do `package.json`.
- **O que acontece:** o teste de estoque roda sempre que existe `DATABASE_URL` no ambiente e **cria** frentes, produtos e movimentações ("TESTE A …"). No ambiente de desenvolvimento usado nesta auditoria, `DATABASE_URL` aponta para o Supabase de produção. Quando rodei `npm run test:stock`, a conexão deu timeout e nada foi gravado. Conferi com uma consulta só de leitura em produção: 0 frentes "TESTE A/B".
- **Sugestão:** o teste só deve rodar com uma variável própria (`TEST_DATABASE_URL`) e recusar hosts `supabase.com`/`pooler`. Também vale tirar a URL de produção do ambiente de desenvolvimento.
- **Esforço:** pequeno.

**GER-02 · ALTO · Bug — `npm test` para na 2ª suíte e esconde as outras 20**
- **Onde:** `package.json:28` (cadeia com `&&`) e `tests/maintenance-reconciliation.integration.test.mjs:5`.
- **O que acontece:** a suíte de reconciliação ainda roda as migrações num SQLite em memória (`DatabaseSync`). As migrações atuais são de Postgres e quebram com `near "EXISTS": syntax error`, então as 4 subtarefas falham e o `&&` interrompe as 20 suítes seguintes. Quem roda `npm test` vê "falhou" e não fica sabendo que o resto está verde.
- **Sugestão:** reescrever essa suíte com um adaptador em memória ou com um Postgres de teste. Enquanto isso, rodar as suítes independentes (sem `&&`) para uma falha não esconder as outras.
- **Esforço:** médio.

**GER-03 · MÉDIO · Melhoria — o deploy publica sem rodar verificações**
- **Onde:** `.github/workflows/deploy.yml:19-20`.
- **O que acontece:** todo push na `main` publica na Hostinger depois de `npm ci` + `npm run build`, sem lint, `tsc` nem testes. Um erro de regra de negócio vai direto para produção.
- **Sugestão:** adicionar `npm run lint` e as suítes de teste antes do build (as que não precisam de banco).
- **Esforço:** pequeno.

**GER-04 · CRÍTICO · Segurança — dependências com vulnerabilidades conhecidas**
- **Onde:** `package.json`.
- **O que acontece:** `npm audit` aponta 10 vulnerabilidades:
  - **`next` 16.2.6 (crítica):** desvio de middleware/proxy, DoS em Server Actions e SSRF.
  - **`postcss` e `sharp` (altas):** vêm junto com o `next`.
  - **Moderadas:** `fflate` 0.7.4 (loop infinito com ZIP64 malformado; roda no navegador ao ler Excel), `exceljs`/`uuid`, `drizzle-kit`/`esbuild` (só desenvolvimento).
- **Sugestão:** atualizar `next` e `eslint-config-next` para 16.3.7, `fflate` para 0.8.x e rodar o build e os testes.
- **Esforço:** pequeno.

**GER-05 · BAIXO · Melhoria — pacotes desatualizados**
- **O que acontece:** `react`/`react-dom` 19.2.6 → 19.3.0, `tailwindcss` 4.2.1 → 4.3.3, `drizzle-orm` 0.45.2 → 0.45.3, `dotenv` 16 → 18, `eslint` 9 → 10, `typescript` 5.9 → 7.0 (major; testar com calma).
- **Sugestão:** atualizar os de versão menor junto com o GER-04 e deixar os de versão maior para depois.
- **Esforço:** pequeno.

**GER-06 · BAIXO · Bug — erros engolidos em silêncio nas telas**
- **Onde:** cerca de 25 chamadas `.catch(() => undefined)`. Exemplos: `app/StockExitsView.tsx:30`, `app/WorkOrdersView.tsx:36`, `app/ThirdPartiesView.tsx:49`, `app/TasksView.tsx:258`, `app/page.tsx:930` e `app/page.tsx:1091` (histórico do equipamento), `app/DailyControlView.tsx:57`.
- **O que acontece:** se a API falhar, a lista ou o contador simplesmente fica vazio, sem mensagem. O usuário acha que "não tem nada".
- **Sugestão:** mostrar um aviso curto ("Não foi possível carregar…") nos carregamentos de dados. Em contadores e badges, pode continuar silencioso.
- **Esforço:** pequeno.

**GER-07 · BAIXO · Melhoria — domínio fixo no código**
- **Onde:** `app/layout.tsx:26` (`metadataBase` = `https://www.jcsistema.online`) e `lib/whatsapp.ts:29` (padrão de `WHATSAPP_PUBLIC_BASE_URL`).
- **Sugestão:** usar uma variável `SITE_URL` única.
- **Esforço:** pequeno.

**GER-08 · BAIXO · Desempenho — imagem pesada e pacote JS grande**
- **Onde:** `public/og.png` (1,7 MB) e a pasta de chunks do build (1,6 MB; maior arquivo com 646 KB).
- **O que acontece:** `og.png` só é usado na prévia de link, mas ocupa 1,7 MB. O `app/page.tsx` (1.197 linhas) importa todos os módulos de uma vez, então o celular baixa Produtos, Pedidos, Funcionários etc. mesmo abrindo só o Controle Diário.
- **Sugestão:** comprimir `og.png` (abaixo de 300 KB) e carregar os módulos grandes sob demanda (`next/dynamic`).
- **Esforço:** médio.

**GER-09 · BAIXO · Melhoria — código compactado em linhas muito longas**
- **Onde:** `app/page.tsx`, `app/EquipmentManagementView.tsx` e várias rotas (ex.: `app/api/system/route.ts`, `app/api/qr/[token]/route.ts`), com várias instruções por linha.
- **O que acontece:** revisões e diffs ficam difíceis, e fica fácil introduzir bug sem perceber.
- **Sugestão:** rodar um formatador (Prettier) aos poucos, módulo por módulo.
- **Esforço:** grande.

## 2. Banco de dados e consultas SQL

**BD-01 · MÉDIO · Bug latente — lista de colunas booleanas da tradução SQLite → Postgres incompleta**
- **Onde:** `db/index.ts:74` (`BOOLEAN_COLUMNS`).
- **O que acontece:** a lista tem 8 colunas; o schema tem 31 colunas booleanas. Ficam de fora, entre outras, `third_party`, `vehicle_pending`, `full_tank`, `balance_adjustment`, `consumption_outlier`, `reading_exception`, `origin_confirmed`, `is_generic_date`, `last_is_generic_date`, `worked_today`, `had_production`, `manual_entry` e `all_service_fronts`. Conferi que **hoje** nenhuma consulta escrita à mão compara essas colunas com 0/1. Mas o primeiro SQL novo com `third_party=1` ou `vehicle_pending=0` quebra em produção com "operator does not exist: boolean = integer".
- **Sugestão:** gerar a lista automaticamente a partir do `db/schema.ts`, ou criar um teste que compare a lista com o schema.
- **Esforço:** pequeno.

**BD-02 · BAIXO · Bug latente — conversão de `?` para `$1` ingênua**
- **Onde:** `db/index.ts` (`toPgQuery`).
- **O que acontece:** a função trata aspas simples, mas não aspas duplas, comentários `--` nem os operadores JSON do Postgres (`?`, `?|`, `?&`). Uma consulta que use qualquer um deles recebe parâmetros no lugar errado.
- **Sugestão:** documentar a limitação e preferir o Drizzle nas consultas novas.
- **Esforço:** pequeno.

**BD-03 · BAIXO · Resquício SQLite — `instr()` ainda no código**
- **Onde:** `lib/history-data.ts:72`.
- **O que acontece:** funciona só porque o adaptador troca `instr` por `strpos`.
- **Sugestão:** escrever `strpos` direto.
- **Esforço:** pequeno.

**BD-04 · MÉDIO · Segurança — certificado do banco não é validado**
- **Onde:** `db/index.ts:40` (`ssl:{ rejectUnauthorized:false }`) e todos os scripts `*.mjs`.
- **O que acontece:** a conexão é criptografada, mas não confere se o outro lado é mesmo o Supabase (risco de interceptação).
- **Sugestão:** usar o certificado CA do Supabase (`ssl: { ca }`).
- **Esforço:** pequeno.

**BD-05 · MÉDIO · Desempenho — pool de conexões sem limites nem tempo máximo de consulta**
- **Onde:** `db/index.ts:35`.
- **O que acontece:** o pool usa o padrão (10 conexões, sem `statement_timeout`). No pooler do Supabase em modo sessão (porta 5432), picos de uso podem esgotar as conexões, e uma consulta travada segura a conexão indefinidamente.
- **Sugestão:** definir `max`, `idleTimeoutMillis` e `statement_timeout`, e considerar a porta 6543 (modo transação).
- **Esforço:** pequeno.

**BD-06 · MÉDIO · Desempenho — 125 chaves estrangeiras sem índice**
- **Onde:** produção. Os casos mais relevantes:
  - `alerts.plan_id` e `alerts.equipment_id`: a tabela `alerts`, com 519 linhas, já teve 171 mil leituras completas.
  - `fuel_movements.fuel_type_id` e `fuel_movements.responsible_employee_id`.
  - `maintenance_plans.maintenance_type_id`.
  - `product_stock_movements.service_front_id` e os `*_item_id`.
  - `material_request_items.product_id`.
  - Os `*_by` de `tasks`.
- **O que acontece:** hoje as tabelas são pequenas e não dói; com o crescimento, telas de alerta, estoque e combustível ficam lentas.
- **Sugestão:** uma migration com os índices das colunas usadas em filtros e junções (os listados acima).
- **Esforço:** pequeno.

**BD-07 · MÉDIO · Dados — datas e horas gravadas como texto em formatos misturados**
- **Onde:** `meter_readings.reading_date` e outras colunas `*_date`/`*_at` do tipo `text`.
- **O que acontece:** as datas simples estão todas em AAAA-MM-DD (verifiquei 0 fora do padrão). Já `reading_date` mistura hora local sem fuso (`2026-08-29T14:01`) com hora UTC (`2026-08-29T13:39:00.000Z`). A ordenação é feita por texto, então duas leituras do mesmo dia com menos de 3 h de diferença podem ficar na ordem errada. Isso afeta "leitura anterior" e as regras de regressão. Caso real: CM-18 em 29/08 (item DAD-06).
- **Sugestão:** padronizar tudo em UTC ISO (`…Z`) ou migrar para `timestamptz`.
- **Esforço:** médio.

**BD-08 · BAIXO · Dados — sessões vencidas nunca são apagadas**
- **Onde:** tabela `user_sessions` (62 das 79 sessões estão vencidas).
- **Sugestão:** apagar as vencidas no login ou por rotina diária.
- **Esforço:** pequeno.

## 3. Dados de produção (consultas só de leitura)

**DAD-01 · ALTO · Dados — 600 saídas de combustível com veículo pendente ou genérico**
- **Onde:** Combustível → Histórico (`vehicle_pending` ou "teste").
- **O que acontece:** são 600 saídas (232.485 L), 82 delas sem responsável. Entre elas estão as 90 saídas "teste" que ainda não têm caminhão. Enquanto não forem identificadas, o consumo por equipamento e por terceiro fica errado.
- **Sugestão:** usar o mesmo fluxo de vínculo feito para o GREGOLETO (responsável → veículo). Para as sem responsável, decidir manualmente.
- **Esforço:** médio.

**DAD-02 · ALTO · Dados — 477 saídas (252.283 L) sem veículo nenhum**
- **Onde:** `fuel_movements` com `movement_type='SAIDA'`, sem equipamento, sem terceiro, sem marca de pendente e sem o texto original do veículo.
- **O que acontece:** essas saídas baixam o saldo, mas não aparecem em nenhum consumo por veículo nem na lista de pendências (porque não estão marcadas como pendentes).
- **Sugestão:** investigar a origem (lançamentos antigos? importação?) e marcá-las como pendentes para aparecerem no filtro de correção.
- **Esforço:** médio.

**DAD-03 · MÉDIO · Dados — troca de óleo sem base de cálculo para muitos equipamentos**
- **Onde:** Troca de Óleo.
- **O que acontece:**
  - 102 equipamentos ativos com horímetro/KM atual = 0 (ex.: CA-02, CA-03, CA-09, CM-10, CM-11, CM-17, CM-24, CC-03).
  - 177 planos ativos sem próxima troca calculada.
  - 6 equipamentos com troca de óleo ligada e nenhum plano: CP-01, JL-10, JL-14, JL-42, KEF7F35, MWD0268. Os JL são julietas (reboques) e provavelmente deveriam ficar com a troca desligada.
- **Sugestão:** lançar a leitura atual desses equipamentos e desligar a troca de óleo dos reboques.
- **Esforço:** médio (é trabalho de cadastro).

**DAD-04 · MÉDIO · Dados — 18 equipamentos não vendidos sem frente**
- **Exemplos:** CP-01, CT-03, CT-04, CT-05, HL-08-QVU2C25, JL-22, KEF7F35, MWD0268, OFN2F90, entre outros.
- **O que acontece:** eles não aparecem nos filtros por frente, e usuários de frente única não os veem nos módulos operacionais.
- **Sugestão:** definir a frente de cada um.
- **Esforço:** pequeno.

**DAD-05 · BAIXO · Dados — 10 equipamentos sem QR Code gerado**
- **Sugestão:** gerar os tokens que faltam.
- **Esforço:** pequeno.

**DAD-06 · MÉDIO · Dados — leituras suspeitas**
- **CA-12:** a leitura #78 (04/09) marca 2.748 h, mas a anterior era 2.923 h. O horímetro voltou sem "regressão autorizada".
- **CM-18:** subiu 4.726 km em 22 minutos em 29/08 (259.147 → 263.873), provável erro de digitação.
- **Sugestão:** revisar as duas leituras na tela de Horímetros/KM.
- **Esforço:** pequeno.

**DAD-07 · MÉDIO · Dados — estoque negativo**
- **Onde:** frente Arapiuns.
- **O que acontece:** ÓLEO SAE 15W40 20L está em −80. Também estão negativos os filtros MB HU12110X (−1), MB separador AXOR 3344 (−2), CAT cabine 938K (−2) e CAT SK-545C (−1).
- **Sugestão:** conferir com um inventário e decidir se o sistema deve bloquear saída sem saldo.
- **Esforço:** pequeno.

**DAD-08 · MÉDIO · Dados — saldo de estoque sem movimentação que o explique, e produtos de teste em produção**
- **O que acontece:** "PRODUTO TESTE ARAPIUNS" tem 150 + 20 unidades e "TESTE MAMURU" tem 100, sem nenhuma movimentação. "CAT FILTRO DE COMBUSTÍVEL 938K – D5 – 140GC – WEILER 250" tem saldo 10 na Arapiuns, mas a soma das movimentações dá −10.
- **Sugestão:** apagar os produtos de teste e conferir esse filtro.
- **Esforço:** pequeno.

**DAD-09 · BAIXO · Dados — 52 nomes de produto repetidos**
- **Exemplos:** "CAT ANEL D5 – COMANDO FINAL" (9×), "CAT RETENTOR 938K" (8×), "CAT RETENTOR 140GC" (7×), "CAT ANEL 938K" (5×).
- **O que acontece:** podem ser peças diferentes com o mesmo nome, mas na busca e na requisição ninguém distingue qual é qual.
- **Sugestão:** colocar a referência no nome ou mostrar a referência em destaque na busca.
- **Esforço:** médio.

**DAD-10 · BAIXO · Dados — saídas fora do padrão do equipamento**
- **O que acontece:** o PC-19 recebeu 1.057 L em 21/07/2025, quando a mediana dele é 107 L. O PC-20 recebeu 564 L, contra mediana de 141 L. Parece transferência lançada como saída, ou erro de digitação.
- **Esforço:** pequeno.

**DAD-11 · BAIXO · Dados — veículos do GREGOLETO sem capacidade de tanque nem consumo esperado**
- **O que acontece:** os 5 veículos estão sem esses dados, então as validações de tanque cheio e de consumo fora da média (25%) não funcionam para eles. As 51 saídas estão sem KM (ver a seção de correção de KM no fim).
- **Esforço:** pequeno.

**DAD-12 · BAIXO · Dados — 7.389 lançamentos importados com "origem não confirmada"**
- **O que acontece:** são 7.376 da planilha e 13 do PDF. O dado é esperado, mas vale criar um filtro para confirmar em lote.
- **Esforço:** pequeno.

**DAD-13 · MÉDIO · Bug/Configuração — nenhuma mensagem de WhatsApp saiu até hoje**
- **Onde:** tabela `whatsapp_deliveries`.
- **O que acontece:** os 4 envios registrados falharam: 2 de teste, 1 manual e 1 automático.
- **Sugestão:** ver a seção 12 (variáveis) e o motivo gravado em `error_reason` na tela do WhatsApp.
- **Esforço:** pequeno a médio.

**DAD-14 · BAIXO · Dados — tabela de alertas acumulando registros "abertos" com nível OK**
- **O que acontece:** há 303 alertas OPEN com nível OK, além de 17 vencidos e 34 próximos em aberto.
- **Sugestão:** fechar automaticamente quando o nível volta a OK, para a Central de alertas e os contadores não somarem registros velhos.
- **Esforço:** pequeno.

**DAD-15 · BAIXO · Dados — usuários que nunca entraram**
- **O que acontece:** os usuários OFICINA `chaveirinho` e `renan` nunca acessaram.
- **Sugestão:** confirmar se ainda precisam de acesso.
- **Esforço:** pequeno.

## 4. Equipamentos / Troca de óleo / Horímetros / Histórico / QR Code

**EQP-01 · ALTO · Bug — "última troca" aparece um dia antes**
- **Onde:** `app/page.tsx:1106` (`formatDate(plan.lastDate, false)`), com a função em `app/page.tsx:225`. A data é gravada em `lib/maintenance-recalculation.ts:220` como `AAAA-MM-DD`.
- **O que acontece:** `new Date("2026-07-05")` é meia-noite UTC, que no horário de Brasília vira 04/07 às 21:00. Reproduzi com `TZ=America/Fortaleza`: sai "04/07/2026".
- **Sugestão:** quando o valor tiver só a data, montar a data local (`AAAA-MM-DDT12:00`) ou apenas inverter o texto para dd/mm/aaaa.
- **Esforço:** pequeno.

**EQP-02 · BAIXO · Visual — histórico mostra hora inventada "09:00"**
- **Onde:** `lib/history-data.ts:40` converte data sem hora para 12:00Z. A exibição está em `app/page.tsx:524`, `:790` e `:1091`.
- **Sugestão:** para registros só com data, mostrar só a data.
- **Esforço:** pequeno.

**EQP-03 · ALTO · Desempenho — recálculo completo da manutenção a cada abertura do sistema**
- **Onde:** `app/api/system/route.ts:23`. O mesmo acontece em `/api/history`, nos PDFs de alertas e de histórico e no QR (`app/api/qr/[token]/route.ts:25`).
- **O que acontece:** cada GET roda `recalculateMaintenanceCycles`, que lê equipamentos, planos, histórico importado, trocas e configurações inteiros. Quando algo mudou, ele também grava planos e alertas. É uma consulta de leitura com efeito colateral, repetida para cada usuário que abre a tela; com mais gente usando ao mesmo tempo, fica lento e pode gerar gravações concorrentes.
- **Sugestão:** recalcular só quando uma leitura, troca, plano ou configuração é salva (as rotas de gravação já fazem isso com `force:true`) e tirar a chamada dos GETs.
- **Esforço:** médio.

**EQP-04 · MÉDIO · Bug — previsão de uso diário vai ficar errada quando passar de 1.000 leituras**
- **Onde:** `app/api/system/route.ts:36` (`LIMIT 1000` nas leituras de toda a frota).
- **O que acontece:** a média diária de cada equipamento usa só as 1.000 leituras mais recentes da frota inteira. Hoje há 188 leituras, então ainda não aparece. Depois disso, equipamentos com leituras antigas ficam com média 0 ou distorcida, e a "previsão" de troca falha.
- **Sugestão:** calcular a média por equipamento no banco (primeira e última leitura dos últimos 90 dias).
- **Esforço:** pequeno.

**EQP-05 · MÉDIO · Desempenho — histórico inteiro carregado sem paginação**
- **Onde:** `app/api/system/route.ts:37` e `app/api/qr/[token]/route.ts:32`.
- **O que acontece:** `/api/system` devolve todo o histórico permanente de uma vez. O QR carrega o histórico de **todos** os equipamentos para mostrar um só.
- **Sugestão:** filtrar por equipamento no banco e paginar o Histórico.
- **Esforço:** médio.

**EQP-06 · MÉDIO · Segurança — regra do QR inconsistente**
- **Onde:** `app/api/qr/[token]/route.ts:24`.
- **O que acontece:** quem abre o link do QR **sem login** vê os planos e o histórico de troca do equipamento. Um usuário **logado** de outra frente recebe 403. Ou seja, o anônimo vê mais que o logado.
- **Sugestão:** decidir a regra. Uma opção é deixar o QR público mostrando só o status resumido. A outra é exigir login e aplicar a mesma regra de frente para todos.
- **Esforço:** pequeno.

**EQP-07 · BAIXO · Bug — QR impresso depende do endereço usado na hora**
- **Onde:** `app/QrCodesView.tsx:24` (usa o endereço aberto no navegador).
- **O que acontece:** se alguém gerar etiquetas abrindo o sistema por `jcsistema.online` (sem www), por IP ou por um link de teste, o QR sai com esse endereço. Além disso, o login é por domínio: quem está logado em `www` não está logado sem o `www`.
- **Sugestão:** gerar o QR sempre com o domínio oficial e redirecionar sem-www → www no servidor.
- **Esforço:** pequeno.

**Conferido e OK:**
- A lista de equipamentos está em ordem natural por prefixo (`sort_key`: CM-2 antes de CM-10) em Equipamentos, Troca de Óleo, Combustível, OS e Movimentação.
- Não encontrei prefixo, código ou placa duplicados.

## 5. Combustível e Terceiros

**CMB-01 · MÉDIO · Visual — botão "Registrar lançamento" desativado quase some no modo escuro**
- **Onde:** Combustível → Novo registro (print `03-escuro-botao-registrar-lancamento-desativado.png`).
- **O que acontece:** o botão desativado fica com opacidade 0,55 sobre o verde, com letra de cerca de 9 px. O aviso laranja "Preencha: …" existe, mas o botão parece não existir.
- **Sugestão:** estado desativado em cinza, com texto legível no tamanho normal.
- **Esforço:** pequeno.

**CMB-02 · ALTO · Dados — saídas do GREGOLETO sem KM**
- **O que acontece:** o consumo (km/L) de Terceiros fica vazio para os 4 caminhões. A correção já está preparada; ver a seção "Correção de KM" no fim.
- **Esforço:** pequeno.

**CMB-03 · BAIXO · Melhoria — sem capacidade de tanque, o aviso de "acima do tanque" não funciona**
- **O que acontece:** é consequência do DAD-11. Vale tornar a capacidade obrigatória no cadastro de caminhão de prestador.
- **Esforço:** pequeno.

**Conferido e OK:**
- As regras de saldo (Frente/Porto) e os ajustes ocultos não entram em entradas nem saídas.
- O saldo em produção está positivo em todos os locais: Diesel Frente 83.919 L e Porto 16.379,99 L; Gasolina Frente 2.508,97 L e Porto 0.
- Editar e excluir lançamento respeita a frente do usuário.

## 6. Produtos, Solicitação de Materiais, Pedidos, Movimentação, OS

**PRD-01 · BAIXO · Visual — filtros rápidos de Pedidos apagados no modo escuro**
- **Onde:** Solicitação de Pedidos (print 04).
- **O que acontece:** "Pedidos pagos", "Parcialmente pagos", "Sem orçamento", "Em análise" e "Urgentes" ficam com contraste 2,57:1 (o mínimo é 4,5:1).
- **Esforço:** pequeno.

**PRD-02 · BAIXO · Visual — contador vermelho "0" nas abas**
- **Onde:** `app/PurchaseOrdersView.tsx:136` e abas vizinhas (print 04).
- **O que acontece:** o vermelho sugere pendência mesmo quando não há nada.
- **Sugestão:** esconder o contador quando for 0.
- **Esforço:** pequeno.

**PRD-03 · BAIXO · Visual — ícone de busca por cima do texto da busca em Pedidos**
- **Onde:** print 04.
- **O que acontece:** a lupa encosta no "P" de "Pesquisar".
- **Esforço:** pequeno.

**PRD-04 · BAIXO · Visual — cabeçalhos de tabela com pouco contraste no tema claro**
- **Onde:** tabelas de Produtos, Terceiros, Funcionários e Usuários.
- **O que acontece:** contraste de 2,96:1.
- **Esforço:** pequeno.

**PRD-05 · MÉDIO · Melhoria — permitir saída com estoque negativo**
- **O que acontece:** ver DAD-07.
- **Sugestão:** bloquear, ou pedir confirmação de um gestor, quando a saída deixa o saldo abaixo de zero.
- **Esforço:** médio.

**Conferido e OK:** o estorno de saída, as OS e os anexos de pedido verificam a frente do usuário no servidor.

## 7. Tarefas

**TAR-01 · BAIXO · Bug — descrição cortada sem botão "Ver mais"**
- **Onde:** `app/materials-tasks.css:62` (corta em 3 linhas) e `app/TasksView.tsx:371` (o botão só aparece com mais de 160 caracteres).
- **O que acontece:** uma descrição curta com várias linhas (lista de itens) é cortada e não mostra "Ver mais". Clicar no título ainda abre os detalhes.
- **Sugestão:** mostrar o botão também quando houver quebra de linha ou quando o texto estiver cortado.
- **Esforço:** pequeno.

**TAR-02 · BAIXO · Visual — letras muito pequenas no card**
- **O que acontece:** a descrição tem 10 px e o "Ver mais" tem 9 px.
- **Esforço:** pequeno.

**Problemas já conhecidos, conferidos no código:**
- O título do card abre a descrição completa, com botão "Copiar descrição": **corrigido**.
- Tarefas concluídas, não realizadas ou canceladas saem da aba principal e ficam só no Histórico (`app/api/tasks/route.ts:149`): **corrigido**.

Em produção existem só 8 tarefas, todas finalizadas, então não havia tarefa aberta para ver na tela real.

## 8. Controle Diário

**Conferido:** o código do Controle Diário **está** na pasta e na `main`: `app/DailyControlView.tsx`, `lib/daily-records.ts` e as rotas `app/api/daily-records/*`. As 21 telas do menu têm código correspondente, e a pasta local está igual à `origin/main`.

**DIA-01 · BAIXO · Observação — módulo praticamente sem uso**
- **O que acontece:** em produção existe 1 registro diário. Vale confirmar se o campo já está usando ou se falta treinamento ou a liberação de acesso aos operadores (há só 1 usuário de campo).
- **Esforço:** —

**DIA-02 · BAIXO · Segurança — foto do registro segue a frente atual do equipamento**
- **Onde:** `lib/daily-records.ts:256`.
- **O que acontece:** a permissão da foto usa a frente **atual** do equipamento, e não a frente do registro. Se o equipamento for transferido, a frente antiga perde acesso às próprias fotos e a nova passa a vê-las.
- **Esforço:** pequeno.

## 9. Visual e uso no celular (todas as telas)

**VIS-01 · ALTO · Visual — menu superior sobreposto no celular**
- **Onde:** todas as telas a 390 px (prints 01 e 02).
- **O que acontece:** os 6 botões de grupo (EQUIPAMENTOS, PRODUTOS, COMBUSTÍVEL, FUNCIONÁRIOS, TAREFAS, USUÁRIOS) ficam espremidos numa linha, com texto cortado ("PAMENTO", "RODUTOS") e um por cima do outro.
- **Sugestão:** no celular, trocar por um menu com rolagem horizontal ou um botão "☰ Menu".
- **Esforço:** pequeno/médio.

**VIS-02 · MÉDIO · Usabilidade — menu ocupa metade da tela no celular**
- **Onde:** Troca de Óleo (print 01).
- **O que acontece:** menu, submenu e sub-submenu ocupam cerca de 440 px dos 844 px antes de começar o conteúdo.
- **Sugestão:** recolher os submenus num seletor.
- **Esforço:** médio.

**VIS-03 · BAIXO · Visual — botão "Transferência" vaza da caixa**
- **Onde:** Combustível no celular (print 02).
- **Esforço:** pequeno.

**VIS-04 · BAIXO · Usabilidade — indicadores um por linha no celular**
- **Onde:** Status da Frota e Dashboard (print 05).
- **O que acontece:** são 4 cards grandes empilhados, e é preciso rolar muito até a lista.
- **Sugestão:** 2 por linha.
- **Esforço:** pequeno.

**VIS-05 · MÉDIO · Acessibilidade — muitas letras minúsculas**
- **O que acontece:** o CSS tem 483 regras com fonte menor que 11 px: 111 de 8 px, 88 de 7 px e 74 de 9 px (quase todas em `app/globals.css`). No sol e com celular simples, é ilegível.
- **Sugestão:** mínimo de 11 px para rótulos e 12 px para texto.
- **Esforço:** médio.

**VIS-06 · BAIXO · Acessibilidade — foco do teclado some**
- **O que acontece:** o CSS remove o `outline` em 5 regras e tem poucas regras `:focus-visible`, então ao navegar com Tab não dá para ver onde se está.
- **Esforço:** pequeno.

**VIS-07 · BAIXO · Acessibilidade — botões "×" de fechar sem nome acessível**
- **Onde:** `app/EmployeeProfile.tsx:63`, `app/FleetStatusView.tsx:133`, `app/EquipmentManagementView.tsx:74/81/87`.
- **Sugestão:** `aria-label="Fechar"`.
- **Esforço:** pequeno.

**VIS-08 · BAIXO · Visual — textos secundários com pouco contraste no tema claro**
- **O que acontece:** "Gestão preventiva", "Administrador", subtítulos de tabela etc. ficam com contraste de 2,6 a 3,1:1.
- **Esforço:** pequeno.

**Conferido:**
- **Modo escuro:** a medição automática nas 21 telas achou pouquíssimo texto ilegível. As exceções são CMB-01 e PRD-01, o que indica que o problema antigo de contraste foi em grande parte resolvido.
- **Layout:** nenhuma tela teve rolagem horizontal a 390 px.
- **Números e datas:** o sistema formata em pt-BR (1.234,56 e dd/mm/aaaa). Os campos de data nativos seguem o idioma do navegador. A exceção é o EQP-01 (data um dia antes).

## 10. Permissões, frentes e login

**SEG-01 · ALTO · Segurança — login sem limite de tentativas**
- **Onde:** `app/api/auth/login/route.ts:8`.
- **O que acontece:** testei 8 senhas erradas seguidas: todas voltaram 401, sem bloqueio nem espera. Dá para tentar senhas indefinidamente. O login de campo tem bloqueio (5 erros por funcionário, 20 por aparelho); o principal não tem.
- **Sugestão:** reaproveitar a mesma lógica (`field_login_attempts`) no login principal.
- **Esforço:** pequeno.

**SEG-02 · MÉDIO · Segurança — faltam cabeçalhos de segurança**
- **Onde:** `next.config.ts`.
- **O que acontece:** faltam HSTS, proteção contra abrir o sistema dentro de outro site (X-Frame-Options/CSP `frame-ancestors`), `X-Content-Type-Options` e `Referrer-Policy`. O cabeçalho `X-Powered-By: Next.js` está exposto.
- **Sugestão:** usar `headers()` no `next.config.ts` e `poweredByHeader: false`.
- **Esforço:** pequeno.

**SEG-03 · BAIXO · Segurança — login confirma que a senha está certa para conta inativa**
- **O que acontece:** a mensagem "Este usuário está inativo" só aparece com a senha certa.
- **Sugestão:** usar a mesma mensagem genérica.
- **Esforço:** pequeno.

**SEG-04 · BAIXO · Segurança — checagem de origem aceita cabeçalhos do próprio cliente**
- **Onde:** `lib/auth.ts:238` e `:246`.
- **O que acontece:** requisição sem `Origin` passa, e o `X-Forwarded-Host` enviado pelo cliente é aceito. Testei com `Origin: https://evil.example` + `X-Forwarded-Host: evil.example` e a resposta foi 200. No navegador, o cookie `SameSite=Strict` protege, por isso o risco é baixo.
- **Sugestão:** comparar com o domínio oficial configurado.
- **Esforço:** pequeno.

**SEG-05 · BAIXO · Segurança — limite por aparelho do login de campo pode ser burlado**
- **Onde:** `lib/field-auth.ts:38` (usa o primeiro `X-Forwarded-For`, que o cliente pode inventar).
- **O que acontece:** o limite por funcionário continua valendo.
- **Esforço:** pequeno.

**SEG-06 · BAIXO · Segurança — busca pública de nomes de funcionários de campo**
- **Onde:** `/api/auth/field/search`.
- **O que acontece:** lista até 8 nomes por busca, sem login e sem limite de taxa. Faz parte do desenho da tela de login de campo, mas permite montar a lista de funcionários.
- **Esforço:** pequeno.

**Testado e OK (servidor, não só menu):**
- **Sem login:** todas as APIs testadas devolvem 401 (`/api/system`, `/api/fuel`, `/api/users`, `/api/employees`, exportações, PDFs, `/api/third-parties`).
- **Usuário OFICINA de uma frente:** recebeu 403 em 13 APIs de outros módulos/admin (usuários, WhatsApp, funcionários, combustível, pedidos, mapa de cargos, as 4 exportações, terceiros, configurações de alerta). Também não conseguiu criar frente nem se promover a ADMIN (`PUT /api/users` → 403).
- **Trocar o id na URL:** as rotas de Combustível, Funcionários (demitir, ausências, ciclos), Estorno de saída, OS, Pedidos/anexos e fotos do Controle Diário verificam a frente no servidor.
- **Vários acessos por usuário:** usuário com acesso a várias frentes sem ser ADMIN é suportado (`user_service_fronts` / "todas as frentes"). Em produção, 0 usuários ativos estão sem frente.
- **Sessão:** dura 7 dias (campo: 12 h). O logout apaga a sessão no banco. Usuário inativado perde o acesso na próxima requisição.

## 11. Integrações: WhatsApp, alertas e QR

Ver DAD-13 (nenhum envio bem-sucedido), DAD-14 (alertas acumulando), EQP-06 e EQP-07 (QR).

**INT-01 · MÉDIO · Bug/Configuração — lembretes repetidos de vencidos nunca rodam**
- **Onde:** `app/api/whatsapp/process/route.ts`.
- **O que acontece:** os lembretes de manutenção vencida dependem de alguém chamar essa rota com o `WHATSAPP_CRON_SECRET`. Não existe agendamento no repositório (nenhum workflow `schedule`), e o painel da Hostinger não é visível daqui.
- **Sugestão:** criar um workflow agendado (cron) no GitHub ou um cron na Hostinger.
- **Esforço:** pequeno.

## 12. Configuração e publicação

Variáveis de ambiente que o código usa:

| Variável | Obrigatória | O que quebra sem ela |
|---|---|---|
| `DATABASE_URL` | Sim | Tudo (erro 500 em todas as telas). |
| `INITIAL_ADMIN_PASSWORD` | Só no 1º acesso | Não cria o administrador inicial. |
| `WHATSAPP_ACCESS_TOKEN` | Para WhatsApp | Envio pela API da Meta (pode ser salvo pela tela, criptografado). |
| `WHATSAPP_PHONE_NUMBER_ID` | Para WhatsApp | Envio pela API da Meta. |
| `WHATSAPP_API_VERSION` | Não (padrão v23.0) | — |
| `WHATSAPP_PUBLIC_BASE_URL` | Não (padrão `https://www.jcsistema.online`) | Link do QR na mensagem aponta para o padrão. |
| `WHATSAPP_CRON_SECRET` | Para lembretes | `/api/whatsapp/process` responde sempre 401 (INT-01). |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Para status de entrega | A Meta não consegue validar o webhook (GET 403). |
| `WHATSAPP_APP_SECRET` | Para status de entrega | Webhook POST 401, então o status "entregue" nunca é atualizado. |
| `WHATSAPP_CREDENTIALS_ENCRYPTION_KEY` | Para salvar o token pela tela | Não dá para gravar o token criptografado. |
| `NODE_ENV` | Automática | — |

As 4 falhas de envio (DAD-13) indicam que parte das variáveis do WhatsApp não está cadastrada, ou que o modelo de mensagem não foi aprovado pela Meta. É preciso conferir no painel da Hostinger.

**CFG-01 · MÉDIO · Dados — fotos e anexos só existem no disco do servidor**
- **Onde:** `uploads/` (fotos de equipamento, produto e Controle Diário, e orçamentos de pedido), em `app/api/equipment/[id]/photo/route.ts:20`, `lib/daily-records.ts:14` e `lib/quote-files.ts:10`.
- **O que acontece:** o deploy automático não apaga essa pasta (o `rsync` é feito sem `--delete`). Mas uma publicação manual por zip que substitua a pasta, ou uma troca de servidor, perde todas as fotos. E não há backup, porque os arquivos não ficam no Supabase.
- **Sugestão:** mover para o Supabase Storage ou fazer backup periódico da pasta.
- **Esforço:** médio.

## Ideias de melhorias (funcionalidades novas)

1. **Painel de consumo por veículo:** L/h ou km/L por equipamento e por caminhão de terceiro, com gráfico dos últimos 90 dias e comparação entre frentes.
2. **Alerta de consumo fora da média:** avisar (tela + WhatsApp) quando um abastecimento passa de ±25% da média do veículo. A regra já existe para terceiros e poderia valer para a frota própria.
3. **Previsão da próxima troca por data:** usar a média de uso diário para mostrar "troca prevista em ~12 dias" e montar a agenda da semana da oficina.
4. **Conciliação de combustível:** comparar a medição física do tanque (régua) com o saldo do sistema e registrar a diferença como perda ou ganho.
5. **Pendências de dados em um só lugar:** uma tela "Pendências" com saídas sem veículo, equipamentos sem leitura, estoque negativo e produtos duplicados, com botão de corrigir.
6. **Leitura de horímetro pelo QR:** o operador escaneia o QR do equipamento e lança a leitura do dia sem procurar na lista.
7. **Checklist diário de pré-uso** (óleo, água, pneus, vazamentos) no Controle Diário, com foto obrigatória quando há problema, abrindo OS automaticamente.
8. **Custo por equipamento:** somar combustível, peças (Movimentação/OS) e mão de obra por equipamento e por mês, e calcular o custo por hora trabalhada.
9. **Controle de pneus e baterias:** vida útil por posição, rodízio e custo por km, que costuma ser o 2º maior custo da frota.
10. **Documentos com vencimento:** além do IPVA, controlar licenciamento, seguro, tacógrafo e ANTT, com alerta 30 dias antes.
11. **Modo offline completo no Controle Diário:** a fila offline já existe; estender para abastecimento e leitura, pensando nas frentes sem sinal.
12. **Relatório semanal automático por WhatsApp/e-mail para o gestor:** trocas vencidas, consumo, estoque crítico e tarefas atrasadas.

## Não consegui testar

- **Painel da Hostinger:** não tenho acesso, então não sei quais variáveis de ambiente estão cadastradas nem se existe cron configurado lá.
- **Domínio real (`jcsistema.online` com e sem `www`):** a rede deste ambiente bloqueia o acesso ao site (resposta 403 do proxy). Por isso não testei o redirecionamento sem-www → www, os links reais dos QR Codes nem a checagem de origem atrás do proxy da Hostinger. A lógica foi revisada no código (EQP-07, SEG-04).
- **Envio real de WhatsApp:** exigiria mandar mensagem de verdade. Só li o histórico de envios (DAD-13).
- **Gravação em produção:** conforme combinado, nenhum teste de gravação foi feito em produção. Os fluxos de gravação (lançar combustível, abrir OS, estorno, importação de trocas, upload de foto) foram revisados no código e testados só na cópia local. Teste sugerido em produção, com um lançamento real pequeno: lançar e excluir uma saída de 1 L numa frente e conferir que o saldo volta ao valor anterior e que o Histórico mostra a exclusão.
- **Exportações Excel/PDF e importação de trocas:** confirmei que as rotas exigem login e permissão (403 para OFICINA). Não abri cada arquivo gerado para conferir coluna por coluna.
- **Tarefas abertas e Controle Diário com dados reais:** em produção não há tarefa aberta e há 1 registro diário, então as telas foram vistas só com os dados de teste locais.
- **Leitores de tela e navegação completa por teclado:** fiz só a checagem automática (VIS-06, VIS-07).

---

## Correção de KM das saídas do GREGOLETO (pedido separado)

O SQL enviado foi adaptado ao banco real (`fuel_movements`) no script `corrigir-km-terceiros.mjs`, com a lista das 44 correções em `scripts/import-abastecimento/data/gregoleto-km-2026-09-29.json`. A **Parte A (conferência)** rodou em produção, só leitura:

- **Casamento:** as 44 correções casaram com exatamente 1 lançamento cada.
- **KM no banco:** nenhuma saída tinha KM gravado, porque a planilha importada não trazia essa coluna. Por isso as 11 saídas do Reginaldo sem data foram casadas pelo caminhão + litros, na ordem do KM. Nos dois pares de 400 L, o de 12/09 vai com 217.875 e o de 16/09 com 218.504.
- **Mudam de caminhão:** #7169 (18/09, 372 L) e #7324 (25/09, 510 L) passam de PFV6F73 para QEH4C88, como indicado no seu script.
- **Conflito:** as correções 21 (Caio, 16/09, 395 L, KM 409.080) e 40 (André, 09/09, 350 L, KM 306.168) caem nas saídas **#7114 e #6945, que foram excluídas** para o total ficar em 19.425 L. Os KMs delas encaixam na sequência, o que indica que eram abastecimentos reais. Pela regra do seu script ("se qualquer lançamento não bater, nada é alterado"), **nada foi gravado** até você decidir:
  - modo `corrigir-km-restaurando-excluidas`: grava as 44 e traz as 2 saídas de volta (total do GREGOLETO passa a 20.170 L);
  - ou gravar só as 42 e manter as 2 excluídas (total fica em 19.425 L).
