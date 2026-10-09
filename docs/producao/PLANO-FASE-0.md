# Módulo Produção — Fase 0: leitura do código e plano

Derruba → Arraste → Medição → Transporte. Este documento é a Fase 0 pedida no prompt: confirma os
módulos que já existem, traz o mapeamento com os **nomes reais** do banco, lista o que é novo e as
decisões que dependem de você. **Nada foi implementado ainda.**

Base lida: branch `main` em 09/10/2026, último commit "App Android: avisos do sistema no celular pelo
Firebase (#71)", migrations `0000` a `0057`.

> O banco de produção não foi consultado: a rede deste ambiente bloqueia a porta 5432 do Supabase.
> Os nomes vêm do schema (`db/schema.ts`), das migrations e das rotinas de importação. Os itens marcados
> com **(conferir no banco)** são confirmados na Fase 1 por um diagnóstico somente leitura (seção 8).

---

## 1. Módulos da seção 0.2 — todos encontrados

| Módulo | Onde está no código |
|---|---|
| Controle Diário | `daily_records`, `daily_record_trips`, `daily_record_fuelings` · `lib/daily-records.ts`, `lib/daily-reports.ts` · `app/DailyControlView.tsx` |
| Combustível (diesel e gasolina) | `fuel_types` (`DIESEL_S10`, `GASOLINA_COMUM`), `fuel_movements` · `lib/fuel.ts`, `lib/fuel-create.ts`, `lib/fuel-rules.ts` · `app/FuelView.tsx` |
| Saída de gasolina por destino e resumo do dia | `lib/more-reports.ts` (`fuelByDestination`) e `lib/fuel-daily.ts` · `app/FuelDailySummary.tsx` |
| Comboio | `convoy_fuel_records`; quando aprovado, vira `fuel_movements` (`created_via = 'COMBOIO'`) |
| Terceiros/Prestadores | `third_parties`, `third_party_vehicles` (com `plate_key` já normalizada), `third_party_employees` · `app/ThirdPartiesView.tsx` |
| Produtos | `products` (tag, name, reference, price), `product_front_stock`, `product_stock_movements` · `lib/stock.ts` (serviço único de estoque) |
| Saída de produtos para equipamento/funcionário | `stock_exits` + `stock_exit_items` (Movimentação, número SAI-000123) · `lib/stock-exits.ts` |
| Assistente JC | schema `assistente` (views), `lib/assistente/catalogo.ts` (permissão por view) |
| Também existe e será reaproveitado | `other_expenses` ("Outros gastos", RELATÓRIOS → Custos), `audit_logs`, `lib/report-export.ts` (PDF/Excel com cabeçalho), `lib/pdf.ts` |

## 2. Mapeamento da seção 0.3 com os nomes reais

| Precisa de | Tabela/código real | Observação |
|---|---|---|
| Frentes | `service_fronts` (`name`, `active`) | Seed: Mamuru, Flexal, Arapiuns, MRN, Belém. Quem vê o quê: `lib/access.ts:frentesVisiveis` |
| Operadores, ajudantes, motoristas | `employees` (`name`, `job_title`, `company`, `status`, `service_front_id`) | `company` é texto (JC, RCA…); lista em `companies`. "Desligado" = `status = 'DEMITIDO'`. Funções em `job_functions` |
| Funções usadas nos filtros | `employees.job_title` | Nomes canônicos já tratados pela importação: `OP. DE MOTOSSERRA - DERRUBA`, `OPERADOR DE MOTOSSERRA`, `AJUDANTE OPERADOR DE MOTOSSERRA`, `OPERADOR DE SKIDDER`, `MOTORISTA DE CAMINHAO NIVEL III` **(conferir no banco)** |
| Skidders e caminhões | `equipment` (`prefix` = SK-10/CM-14, `type`, `brand`, `model`, `plate`, `sold_at`) | **A coluna `plate` já existe.** `type` é a sigla do prefixo (`SK` skidder, `CM` caminhão, `JL` julieta/reboque) conforme a importação da frota **(conferir no banco)** |
| Itens de consumo (lima, corrente, sabre, óleo 2T) | `products` | Precisa da marcação nova "Usar na Produção" |
| Gasolina e diesel | `fuel_types` + `fuel_movements` | **Não são Produtos.** Não vou criar produtos "Gasolina (L)"/"Diesel (L)", porque isso abriria um segundo estoque de combustível. Ver decisão D2 |
| Retirada de material por funcionário | `stock_exits` (`destination_type = 'EMPLOYEE'`) + `stock_exit_items` + `lib/stock.ts` | Ganha o vínculo com o projeto (coluna nova) |
| Gasolina da derruba | `fuel_movements` (`movement_type = 'SAIDA'`, gasolina) | Ganha o vínculo com o lançamento da derruba (coluna nova) |
| Diesel por equipamento (inclusive comboio) | `fuel_movements` com `equipment_id` e `movement_date` | Só saídas não excluídas e sem ajuste de saldo; o comboio entra depois de aprovado |
| KM / horímetro / operador do dia | `daily_records` (`start_reading`, `end_reading`, `reading_unit`, `review_status`) | Operador: `field_operator_id` / `user_id` (login de campo) → `users.employee_id` → `employees`; ou `operator_name` digitado |
| Transportadoras, motoristas e caminhões de terceiros | `third_parties`, `third_party_employees`, `third_party_vehicles` | Diesel do caminhão de terceiro: `fuel_movements.third_party_vehicle_id` |
| Despesas sem estoque | `other_expenses` | Ver decisão D3 |
| PDFs | `lib/report-export.ts` (`exportTable`: PDF paisagem e Excel com título, filtros e quem gerou) e `lib/pdf.ts` | — |
| WhatsApp | `lib/whatsapp.ts` (API oficial da Meta) | Só envia para números individuais. Ver decisão D7 |
| Auditoria | `audit_logs` (`entity_type`, `entity_id`, `action`, `previous_value`, `new_value`) | Mesmo padrão dos outros módulos |
| Permissões e login de campo | `lib/auth.ts` (`PERMISSION_GROUPS`, `PROFILE_DEFAULTS`, `FIELD_ALLOWED_API`), `users.role = 'CAMPO'` | Ver seção 5 |

## 3. Diferenças entre o prompt e o sistema real

1. **Deploy e migrations já são automáticos.** Um push na `main` dispara `.github/workflows/deploy.yml`
   (lint → checagem de tipos → testes → build → rsync para a Hostinger → reinício). As migrations rodam
   pelo workflow **"Migrar banco de dados"** (`db-migrate.yml`, botão "Run workflow"). O prompt fala em
   zip manual e `db:migrate` na sua máquina. → decisão D1.
2. **Custo do combustível.** As saídas de combustível não gravam valor: o custo é o **custo médio
   ponderado do estoque**, calculado na hora (`lib/fuel-rules.ts:computeFuelCosts`). Todos os
   relatórios usam essa conta. Um "preço da gasolina por frente" criaria um segundo valor para o mesmo
   litro. → decisão D2.
3. **A saída de combustível não aceita "funcionário próprio" como destino.** Hoje toda saída exige um
   equipamento da frota ou um terceiro. A saída automática da derruba precisa de um destino novo:
   "Produção — Derruba".
4. **A saída de combustível não valida saldo** (pode ficar negativo). A saída de produto **bloqueia**
   sem saldo, e só ADMIN/GESTOR liberam saldo negativo. Vou manter as duas regras como estão: a
   gasolina mostra aviso e o material segue a regra do estoque.
5. **O Controle Diário já registra produção de PORTO**: viagens, toras e metragem por viagem do
   caminhão (`production_type = 'PORTO'`, `port_trips`, `port_logs`, `port_volume_m3`,
   `daily_record_trips`). Isso se sobrepõe às viagens do Transporte. → decisão D4.
6. **O sistema é uma página única com abas no topo** (`app/page.tsx`), sem rotas `/producao/...` e sem
   menu lateral. O item novo é um botão **PRODUÇÃO** na barra de módulos. Os links compartilháveis
   ficam assim: `/?tela=producao&aba=derruba&sub=lancamento&frentes=1,2` (o sistema já usa
   `?tela=` em outro lugar).
7. **Já existe um seletor global de frente** no topo, de uma frente só (cookie `jc_active_front`). O
   filtro com checkboxes da Produção funciona dentro do módulo: começa com o que está no seletor
   global, fica na URL e no navegador, e o servidor sempre cruza com as frentes que a pessoa pode ver.
8. **Login de campo tem permissões fixas.** O motorista do comboio ganhou acesso por uma marcação no
   usuário (`users.convoy_fuel_register`). O apontador da Produção segue o mesmo caminho: marcação
   nova `users.production_register`, liberada em "Funcionários de campo".
9. **Convenção do schema:** tabelas e colunas em inglês, `active`, datas como texto `AAAA-MM-DD`,
   números `double precision` (arredondados no código: R$ com 2 casas e Francon com 4), `created_by`
   apontando para `users`. As tabelas novas seguem isso, com prefixo `production_`. As views do
   Assistente continuam em português, no schema `assistente`.
10. **`html-to-image` não está instalado.** O "Copiar/Baixar imagem" da Postar Produção precisa desse
    pacote novo (MIT, sem dependências), ou de um desenho feito à mão em canvas.

## 4. Decisões que dependem de você (com a minha recomendação)

| # | Decisão | Recomendo |
|---|---|---|
| D1 | Como publicar | Seguir o fluxo que já existe: eu entrego cada fase nesta branch; você roda "Migrar banco de dados" escolhendo a branch (as migrations só **acrescentam**, então rodá-las antes não quebra o sistema no ar) e faz o merge na `main`, que publica sozinho. Sem zip. Se o upload manual ainda for o que você usa de fato, me avise que eu gero o pacote com `tar -a -cf` |
| D2 | Valor da gasolina da derruba | **Custo médio do estoque**, a mesma conta do Combustível. O relatório de gasolina e a análise da derruba mostram sempre o mesmo valor, porque é a mesma conta. O "preço por frente" vale só para os Produtos (lima, corrente…). O teste "8 L × R$ 6,29 = R$ 50,32" passa quando o custo médio do estoque da frente for R$ 6,29 |
| D3 | Onde ficam as despesas sem estoque (reparo de motosserra sem peça, perda total, custo operacional) | **Em "Outros gastos" (`other_expenses`)**, com colunas novas de produção, em vez de uma tabela `prod_despesas`. Assim elas entram sozinhas em RELATÓRIOS → Custos (custo × produção) e no custo da skidder quando houver equipamento. Em "Outros gastos" aparecem com o selo "Produção" e só se editam pela Produção |
| D4 | Transporte × Controle Diário (PORTO) | **O Transporte é o registro oficial da viagem** (tem romaneio, projeto e Francon; o Diário não tem). Não crio nada automaticamente de um lado para o outro. Em "Lançar Viagem", ao escolher caminhão e data, mostro só para leitura o que o Diário já tem ("Diário: 2 viagens, 48 toras"), e o Relatório ganha a coluna "Viagens no Diário" para conferência. **Pergunta:** a "metragem" que o motorista informa no Diário é o mesmo volume Francon do romaneio? |
| D5 | Permissões padrão | ADMIN: tudo. **GESTOR: `producao.ver`, `producao.custos`, `producao.lancar` e `producao.gerenciar` por padrão**: o prompt pede isso, mas a regra do projeto em `lib/auth.ts` exige sua confirmação explícita. Perfis de usuário (Oficina, Operador, Almoxarifado): nada por padrão; você libera por pessoa em Usuários → Permissões (regra do projeto) |
| D6 | Apontador de campo e gasolina | O apontador lança também os **litros** de gasolina da grade (o que gera a saída), sem ver nenhum valor em R$. A saída fica registrada no nome dele. A alternativa é esconder a coluna Gasolina para o login de campo |
| D7 | "Enviar no WhatsApp" para grupo | **Não fazer.** A API oficial da Meta não envia para grupo. O botão **Compartilhar** (`navigator.share`) já leva a imagem a qualquer grupo pelo celular |
| D8 | Caminhão com várias viagens no mesmo dia | O KM do Controle Diário e o diesel do dia são **divididos igualmente entre as viagens** daquele caminhão no dia. A alternativa é dividir pelo Francon |

## 5. Permissões (grupo novo "Produção" em Usuários → Permissões)

| Chave | O que libera |
|---|---|
| `producao.ver` | Abrir o módulo e consultar produção, saldos, medições, viagens, resumo e Postar Produção, **sem valores em R$** |
| `producao.custos` | Ver despesas, custos, custo/árvore, preço por m³ e as análises com R$ (inclusive os PDFs) |
| `producao.lancar` | Lançar e corrigir derruba, arraste, medição, viagens e despesas em etapas **não finalizadas**, nas frentes que vê |
| `producao.gerenciar` | Projetos, equipes, preços por frente, metas, observações; finalizar e **reabrir** etapas; excluir lançamentos |
| Só ADMIN (pelo perfil) | Importar Excel, desfazer lote, editar a lista de motivos |

- **Apontador de campo** (login simplificado): marcação "Apontador da Produção" na tela Funcionários de
  campo. Ela dá `producao.lancar` e libera só as rotas `/api/producao/campo/*` em
  `FIELD_ALLOWED_API`. O apontador vê só o Lançamento da Derruba e do Arraste, nas frentes dele, sem
  R$ e sem análises. No celular, a tela de campo ganha a aba "Produção", como já acontece com
  "Abastecimentos".
- Toda checagem fica no servidor (`authorize` + frente do projeto ∈ `frentesVisiveis`). Nenhum valor em
  R$ sai da API para quem não tem `producao.custos`.

## 6. Modelo de dados

### 6.1 Tabelas novas

| Tabela (nome real) | Equivale a | Colunas principais |
|---|---|---|
| `production_projects` | prod_projetos | `service_front_id`, `name`, `camp` (alojamento), `active`, `felling_status`, `skidding_status`, `measurement_status`, `hauling_status` (`NAO_INICIADO`/`EM_ANDAMENTO`/`FINALIZADO`), `felling_notes`… `hauling_notes`. Único: frente + nome (sem diferenciar maiúsculas) |
| `production_stage_events` | log de status | `project_id`, `stage`, `action` (`FINALIZOU`/`REABRIU`), `user_id`, `note`, `occurred_at` |
| `production_teams` / `production_team_members` | prod_equipes / integrantes | equipe: frente, nome, responsável (`employees`), `active`; integrante: `employee_id`, `joined_at`, `left_at` (vazio = ativo) |
| `product_front_prices` | produto_preco_frente | `product_id`, `service_front_id`, `price`. Chave: produto + frente. Preço efetivo = preço da frente; se não houver, `products.price` |
| `production_targets` | prod_metas | `service_front_id`, `stage` (`DERRUBA`/`ARRASTE`), `trees_per_operator_day` |
| `production_reasons` | prod_motivos | `code` (C.09), `description`, `active`. Seed: C.01 CHUVA, C.02 MANUTENÇÃO DE MOTOSSERRA, C.09 MADEIRA GROSSA… |
| `production_felling` | prod_derruba | `project_id`, `felling_date`, `operator_employee_id`, `helper_employee_id`, `trees`, `ipes` (≤ trees), `gasoline_liters`, `reason_id`, `justification`. Único: projeto + data + operador |
| `production_skidding` | prod_arraste | `project_id`, `skidding_date`, `operator_employee_id`, `equipment_id` (skidder), `trees`, `ipes`, `rejects`, `reason_id`, `justification`. **Sem coluna de combustível.** Único: projeto + data + operador + skidder |
| `production_measurements` | prod_medicao_leituras | `project_id`, `period_start`, `reading_date`, `cum_trees`, `cum_logs`, `cum_francon`, `initial_reading`, `notes`, `lower_justification`. Único: projeto + data |
| `production_trips` | prod_viagens | `trip_date`, `trip_time`, `waybill` (romaneio), `third_party_id` (vazio = frota própria), `project_id`, `destination`, `driver_employee_id` / `driver_third_party_employee_id` / `driver_name`, `truck_equipment_id` / `truck_third_party_vehicle_id`, `truck_plate`, `trailer1_plate`, `trailer2_plate`, `julietas_mode` (`AUTO`/`0`/`1`/`2`), `logs`, `francon`, `notes` |
| `production_import_batches` | prod_lotes_importacao | `kind`, `file_name`, `status`, `summary`, `undone_at`, `undone_by` |

Todas com `created_at`, `updated_at` e `created_by` (e `updated_by` onde houver edição). Índices:
(projeto, data), (operador, data), (equipamento, data), frente.

### 6.2 Colunas novas em tabelas que já existem

| Tabela | Coluna nova | Para quê |
|---|---|---|
| `products` | `production_use` (boolean, padrão FALSE) | "Usar na Produção" (para a lista não trazer os ~3.000 itens) |
| `stock_exits` | `production_project_id`, `production_sector` (`DERRUBA`/`ARRASTE`/`SECUNDARIA`), `production_kind` (`MATERIAL`/`MANUTENCAO`/`PERDA_TOTAL`), `production_tool` (identificação da motosserra) | Material e peça lançados pela Produção. A skidder do arraste usa o `equipment_id` que já existe |
| `fuel_movements` | `production_felling_id` (único, FK `production_felling`) | Vínculo 1 para 1 da gasolina com a linha da derruba |
| `other_expenses` (se D3 = sim) | `production_project_id`, `production_sector`, `production_kind` (`MANUTENCAO`/`PERDA_TOTAL`/`CUSTO_OPERACIONAL`), `employee_id`, `production_tool`, `quantity`, `unit_value`, `origin` (`MANUAL`/`IMPORTACAO`), `import_batch_id` | Despesas da produção sem estoque |
| `users` | `production_register` (boolean) | Apontador da Produção no login de campo |

### 6.3 SQL de agregação (migration customizada `drizzle-kit generate --custom`)

- `production_fuel_by_equipment_day(ids, de, ate)`: litros de diesel por equipamento e dia. Usada pelo
  Arraste (com rateio pelas árvores quando a skidder trabalhou em mais de um projeto no dia) e pelo
  Transporte.
- `production_meters_by_equipment_day(ids, de, ate)`: horas/KM e operador do dia, lidos do Controle
  Diário (só leituras sem "Conferir").
- Views `production_project_totals` (derrubadas, ipês, arrastadas, refugos, saldo, medido, transportado
  por projeto) e `production_measurement_deltas` (Δ com `LAG()` por projeto, na ordem da data).
- Views do Assistente: `assistente.v_producao_derruba`, `v_producao_arraste`, `v_producao_medicao`,
  `v_producao_viagens`, `v_producao_projetos` (sem R$, permissão `producao.ver`) e
  `v_producao_custos` (permissão `producao.custos`), com o `GRANT` para `assistente_leitura`.

## 7. Como os lançamentos tocam os outros módulos

- **Gasolina da derruba:** salvar a grade cria/atualiza/exclui, na mesma transação, a saída em
  `fuel_movements` (gasolina, frente do projeto, estoque Frente, responsável = operador, destino
  "Produção — Derruba <projeto>"). No Combustível ela aparece com o selo **Produção** e a edição ou
  exclusão é recusada no servidor ("altere pela Produção"). O resumo do dia e o relatório por destino
  ganham o tipo "Produção". Saldo que ficaria negativo gera aviso, não bloqueio.
- **Material / peça:** cria uma saída de estoque normal (SAI-…) com projeto e setor, gravando o preço
  efetivo da frente no item. Na Movimentação aparece com o selo **Produção** e o estorno é feito pela
  Produção.
- **Despesa sem estoque:** `other_expenses` com os campos de produção (D3).
- **Despesa de colaborador secundário:** saída para funcionário com setor `SECUNDARIA`, nunca com
  skidder, e fora do custo da skidder e do desempenho do operador.
- **Diesel do arraste e do transporte:** só leitura, cruzado de `fuel_movements`. Abastecimento do
  comboio ainda pendente de aprovação não entra (só depois de aprovado).
- **Status das etapas:** projeto novo nasce com Derruba "Em andamento" e as outras etapas "—". O primeiro
  lançamento de uma etapa a coloca em "Em andamento". Etapa finalizada recusa lançamento no servidor;
  quem tem `producao.gerenciar` reabre, e fica registrado quem e quando.

## 8. Código, telas e rotas

- **Regras puras (testáveis):** `lib/production-rules.ts` (saldo, % processado, % refugo,
  média/dia, meta, Δ de medição, m³/árvore, projeção, rateios, julietas pelas placas). Testes em
  `tests/production-rules.test.mjs` com os números dos critérios de aceite (133,50; baixa 65; 3,99%;
  3,8943; 211; 50,32), incluídos no `npm test` que o deploy roda.
- **Banco:** `lib/production.ts`, `lib/production-fuel.ts`, `lib/production-expenses.ts`,
  `lib/production-reports.ts`, `lib/production-import.ts`.
- **API:** `/api/producao/...` (`contexto`, `projetos`, `equipes`, `precos`, `metas`, `motivos`,
  `derruba`, `despesas`, `importar`, `arraste`, `materiais`, `medicao`, `transporte/viagens`,
  `transporte/placa`, `transporte/relatorio`, `transporte/terceiros`, `resumo`, `postar`) e
  `/api/producao/campo/*` para o apontador.
- **Telas:** `app/ProductionView.tsx` (abas + filtro de frentes) e uma tela por aba em `app/production/`,
  CSS próprio com os tokens do tema (modo escuro incluso). A grade da derruba vira cards no celular.
- **Telas existentes que mudam:** menu (botão PRODUÇÃO), tela de campo (aba Produção), Combustível
  (selo e bloqueio), Movimentação (selo e bloqueio), Outros gastos (selo), Produtos ("Usar na
  Produção"), Funcionários de campo ("Apontador da Produção"), Permissões (grupo novo), catálogo do
  Assistente.
- **Diagnóstico somente leitura** `scripts/diagnosticar-producao.mjs`, rodado no workflow "Migrar banco
  de dados" (já existem outros iguais lá). Ele confirma os tipos SK/CM/JL, as funções reais dos
  funcionários e as empresas, e mostra como a gasolina da motosserra é lançada hoje.

## 9. Entrega em fases

| Fase | Conteúdo | Migration |
|---|---|---|
| 1 | Projetos, Equipes, Preços por frente + "Usar na Produção", metas, motivos, filtro de frentes, permissões, apontador de campo (só o acesso), diagnóstico | `0058_producao_base` |
| 2 | Derruba completa: grade em lote, gasolina automática, acumulado, histórico, material, manutenção, importação Excel com desfazer, análises, multi-frente, PDFs | `0059_producao_derruba` + views |
| 3 | Arraste: saldo, Controle Diário, diesel cruzado, despesas (inclusive secundária), materiais consumidos, análises | `0060_producao_arraste` + funções |
| 4 | Medição: leituras acumuladas, Δ, cards | `0061_producao_medicao` |
| 5 | Transporte: viagens, placa (própria + terceiros), relatório com KM/diesel cruzados, terceiros, conferência com o Diário | `0062_producao_transporte` |
| 6 | Resumo de Projeto, Postar Produção (imagem, compartilhar, texto WhatsApp), views do Assistente | `0063_producao_assistente` |

Ao final de cada fase: `npm run lint`, `npx tsc --noEmit`, `npm test` e `npm run build` limpos (os
mesmos passos que o deploy roda); a migration gerada com `npm run db:generate` (ou `--custom` para
views/funções); o passo a passo de publicação (D1); e um roteiro curto de teste manual.
