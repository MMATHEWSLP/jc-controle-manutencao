# Manual do Sistema JC (usado pelo Assistente JC)

Manual curto de cada tela: caminho no menu, o que faz e como fazer as tarefas mais comuns. O menu superior tem os grupos EQUIPAMENTOS e PRODUTOS (com sub-botões) e os botões COMBUSTÍVEL, FUNCIONÁRIOS, TAREFAS, USUÁRIOS e PENDÊNCIAS. O seletor "Frente" no topo filtra todas as telas pelas frentes escolhidas. Cada pessoa só vê os módulos liberados no seu usuário e as frentes vinculadas a ele.

## Seletor de frente
Caminho: topo da tela, ao lado do tema claro/escuro.
O que faz: escolhe a frente em exibição (ou "Todas as frentes") em todo o sistema. Quem tem uma frente só não vê o seletor.

## Equipamentos — Cadastro / Listagem
Caminho: EQUIPAMENTOS → Cadastro / Listagem.
O que faz: lista a frota com código, tipo, frente, situação e leitura atual; abre a ficha do equipamento (dados, plano de manutenção, histórico, alertas e peças aplicáveis).
Como cadastrar: botão "＋ Novo equipamento", preencher código/prefixo, tipo, marca, modelo, controle (horímetro, KM ou os dois), frente e salvar.
Como transferir de frente: na linha do equipamento, botão "Transferir" → "Transferir para" (nova frente) e observação → "Confirmar transferência". Fica no histórico de transferências. Precisa da permissão "Pode transferir equipamentos entre frentes".
Como marcar vendido: na linha do equipamento, "Marcar como vendido" (data da venda). Sai da frota ativa, mas o histórico é preservado e dá para "Desfazer venda".

## Troca de Óleo
Caminho: EQUIPAMENTOS → Troca de Óleo. Abas: Dashboard, Equipamentos da troca, QR Codes, Horímetros / KM, Registrar troca de óleo, Central de alertas, WhatsApp, Histórico.
O que faz: controla os planos de troca de cada equipamento (intervalo em horas ou km) e mostra o que está normal, próximo, vencido ou urgente.
Como registrar uma troca: Troca de Óleo → Registrar troca de óleo → escolher o equipamento, o serviço, a data, a leitura (horímetro/KM), número da OS e mecânico → Salvar. A próxima troca é recalculada.
Pelo celular: ler o QR Code do equipamento e registrar a troca ou a leitura direto.
Como lançar leitura de horímetro/KM: Troca de Óleo → Horímetros / KM → equipamento, data e leitura → Salvar (ou importar planilha de leituras).
Como ver as vencidas: Troca de Óleo → Central de alertas (filtros por situação e frente; exporta PDF e envia pelo WhatsApp).

## Status da Frota
Caminho: EQUIPAMENTOS → Status da Frota.
O que faz: mostra cada equipamento operando, parado, em manutenção ou aguardando peça/pedido/mecânico, com o tempo parado.
Como registrar uma parada: clicar no equipamento → mudar o status, informar motivo, problema, local e mecânicos → Salvar. Pedidos de peça: "＋ ADICIONAR PEDIDO".
Relatório: "⇩ EXPORTAR RELATÓRIO PDF" (movimentações do dia).

## Ordem de Serviço
Caminho: EQUIPAMENTOS → Ordem de Serviço.
O que faz: O.S. por equipamento (OS-000123) com descrição, mecânicos e peças. As peças lançadas saem do estoque da frente na hora.
Como abrir: "＋ Abrir O.S." → equipamento, leitura, descrição → "ABRIR O.S.". Depois lançar peças (produto, quantidade, quem retirou, aplicação → "Lançar") e mecânicos.
Como fechar: botão "Fechar" / "FECHAR O.S." (pede observação opcional). Fechar/reabrir precisa da permissão de fechamento.

## Pneus e Baterias
Caminho: EQUIPAMENTOS → Pneus e Baterias.
O que faz: cadastro de cada pneu (número de fogo) e bateria, com montagem, rodízio, recapagem, conserto, inspeção e descarte.
Como cadastrar: "+ Cadastrar" → tipo, número, marca, medida, compra. Para montar/rodar/recapar: abrir o item e lançar o evento.

## Custos e Consumo
Caminho: EQUIPAMENTOS → Custos e Consumo (ADMIN e GESTOR).
O que faz: por equipamento e período, litros e valor de combustível, consumo médio (km/L ou L/h), peças e manutenções, com desvio de consumo.

## Resumo semanal
Caminho: EQUIPAMENTOS → Resumo semanal (ADMIN e GESTOR).
O que faz: resumo da semana (operação, manutenção, combustível e custos) e o texto para o WhatsApp.

## Controle Diário
Caminho: EQUIPAMENTOS → Controle Diário (e o login de campo dos operadores).
O que faz: o operador registra o dia do equipamento: se trabalhou, leitura inicial e final, abastecimentos, viagens/toras (baldeio) ou metros (porto), problemas e fotos. Inclui o checklist pré-uso antes de ligar a máquina.
Como lançar por outra pessoa: Controle Diário → lançamento manual informando o nome do operador.
Mudança de frente pedida pelo operador: aparece para aprovação de ADMIN/GESTOR (número no botão do menu).

## Produtos
Caminho: PRODUTOS → Produtos.
O que faz: catálogo de peças, insumos, EPI e mantimentos (TAG, nome, referência, marca, fornecedor, aplicação, preço) com o saldo de cada frente e a aba Histórico de cada produto.
Como cadastrar: "＋ Novo produto" → TAG (sugere a próxima), nome, referências, preço, fornecedor, marca, aplicação → Salvar.
Como ajustar o saldo: abrir o produto → saldo da frente → informar o novo saldo (fica como "Ajuste manual" no histórico).
Importações: "Importar CSV" (cadastro) e "Importar movimentações" (histórico do almoxarifado antigo, só ADMIN; não altera saldo por padrão).

## Solicitação de Materiais
Caminho: PRODUTOS → Solicitação de Materiais.
O que faz: pedido de material entre frentes (SOL-000123). Quem envia escolhe de que frente os produtos saem; o envio baixa o estoque da origem e soma na frente que pediu.
Como pedir: "＋ Nova solicitação" → "＋ ADICIONAR ITEM" (produto ou item digitado, quantidade, unidade) → Enviar.

## Solicitação de Pedidos (Compras)
Caminho: PRODUTOS → Solicitação de Pedidos.
O que faz: compra externa (PED-000123) com etapas: solicitação → aprovação → cotação pelo comprador → pagamento → envio → recebimento. O recebimento dá entrada no estoque dos itens ligados a produto.
Como pedir: "＋ Novo pedido" → frente, departamento, urgência, itens → Enviar. Cada etapa é feita por quem tem a permissão daquela etapa.

## Movimentação (saída de produtos)
Caminho: PRODUTOS → Movimentação.
O que faz: saída de produtos do estoque (SAI-000123) para um equipamento, funcionário, departamento ou terceiro/prestador; aba Histórico com filtros e exportação em Excel. O histórico também mostra as peças de O.S. fechadas e o histórico importado do sistema antigo.
Como lançar: na tela Movimentação preencha frente, data, destino (veículo, funcionário, departamento ou terceiro) e os produtos com quantidades → "LANÇAR SAÍDA". Para desfazer: "Estornar" na saída (precisa da permissão).
Departamentos: a lista é única (Movimentação e Compras) e é mantida por quem tem "departments.manage".

## Terceiros
Caminho: PRODUTOS → Terceiros (também na aba Terceiros do Combustível).
O que faz: cadastro de prestadores, terceirizadas e pessoas físicas e dos veículos deles (placa, medidor, capacidade, consumo esperado). Usado nas saídas de combustível e de produtos.
Como cadastrar: "＋ Novo terceiro" → nome, tipo, CNPJ, contato → adicionar veículos.

## Combustível
Caminho: COMBUSTÍVEL. Abas: Novo Registro, Histórico, Terceiros, Consumo de Terceiros, Tanque (régua).
O que faz: entradas, saídas e transferências de diesel/gasolina por frente, com dois estoques por frente (Frente e Porto). O saldo é sempre a soma dos lançamentos.
Como lançar uma entrada: Novo Registro → tipo Entrada → frente, data, combustível, origem (Frente ou Porto), litros e valor por litro → Salvar.
Como lançar uma saída: Novo Registro → tipo Saída → frente, data, combustível, estoque de origem → para a frota JC escolha o equipamento e a leitura; para terceiro/prestador escolha a empresa e o veículo → litros, tanque cheio, responsável → Salvar.
Como transferir diesel entre frentes: Novo Registro → tipo Transferência → Frente de Serviço = frente de onde o diesel SAI, Origem = estoque de saída (Frente ou Porto) → em Filial Destino escolha a frente que RECEBE e em Destino o estoque (Frente ou Porto) → data, combustível, litros e responsável → Salvar. Sai do saldo da origem e entra no saldo do destino num lançamento só. Para mover entre Frente e Porto da mesma frente, deixe a mesma filial e mude só o Destino.
Como corrigir ou excluir: Histórico → editar/excluir o lançamento (precisa de "fuel.manage").
Importar planilha / ficha: botão "⇧ Importar planilha" no topo do Combustível (modelo para baixar), ou pelo Assistente JC → "📷 Enviar ficha".
Resumo do dia: Histórico → Resumo do dia (mensagem do WhatsApp e PDF das saídas).
Conferência do tanque: aba Tanque (régua) → Nova medição (litros ou régua); mostra a diferença para o saldo do sistema e permite gerar ajuste de saldo.

## Funcionários
Caminho: FUNCIONÁRIOS.
O que faz: cadastro de funcionários (função, empresa, admissão, frente, situação), transferências entre frentes, ciclo de folga (trabalho/viagem/folga), afastamentos/atestados, demissão e lista de restritos.
Como cadastrar: "＋ Novo funcionário" → nome, função, empresa, admissão, frente → Salvar.
Como lançar folga: abrir o funcionário → ciclo de folga → datas de saída da frente, chegada em casa, saída de casa e chegada na frente.

## Tarefas
Caminho: TAREFAS.
O que faz: tarefas e subtarefas com responsável, prazo e urgência; o responsável pede conclusão (ou não realização) e quem criou aprova. A visibilidade segue os cargos de tarefas.
Como criar: "＋ Nova tarefa" → título, descrição, responsável, prazo, urgência → Salvar. Para concluir: abrir a tarefa → Concluir (com observação).

## Pendências
Caminho: PENDÊNCIAS (ADMIN e GESTOR).
O que faz: lista dados que precisam de correção: saídas de combustível sem veículo, equipamentos sem leitura, sem plano ou sem frente, leituras suspeitas, estoque negativo, produtos duplicados, veículos de terceiros incompletos, usuários parados. Cada grupo diz em que tela corrigir.

## Usuários
Caminho: USUÁRIOS (quem tem permissão).
O que faz: cria usuários, define perfil (ADMIN, GESTOR, usuário), frentes que enxerga, permissões por módulo e cargo de tarefas; ativa/desativa e redefine senha. Funcionário de campo entra só com nome + código no Controle Diário.

## Assistente JC
Caminho: botão "✦ Assistente JC" no canto da tela.
O que faz: responde perguntas sobre os dados do sistema (só consulta, nunca grava), mostra tabelas com "Baixar Excel" e "Ver no sistema", e lê fotos de fichas de abastecimento ("📷 Enviar ficha") para gerar a planilha de importação. Respeita as frentes e os módulos liberados para cada usuário.
