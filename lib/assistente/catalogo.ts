import type { Permission, Profile } from "../auth";

// ---------------------------------------------------------------------------------------------
// Catálogo do Assistente JC: as views do schema "assistente" (drizzle/0038_assistente_views.sql),
// com descrição das colunas em português e os valores possíveis dos campos de situação/tipo.
// É a ÚNICA lista do que o assistente pode consultar: a ferramenta consultar_dados valida view,
// colunas e operadores contra ele, e o resumo vai no prompt de sistema. Coluna nova numa view =
// incluir aqui (tests/assistente-catalogo.test.mjs confere o catálogo contra o banco no CI).
//
// escopo:  "frente"  → o servidor filtra pelas frentes do usuário (colunas em colunasFrente);
//          "global"  → cadastro único, sem frente (terceiros, fornecedores);
//          "usuario" → quem não é ADMIN só vê as linhas em que é responsável ou criador;
//          "admin"   → só ADMIN.
// ---------------------------------------------------------------------------------------------
export type TipoColuna = "texto" | "numero" | "data" | "sim_nao";
export type ColunaCatalogo = { nome: string; tipo: TipoColuna; descricao: string; valores?: readonly string[] };
export type SecaoTela = "Equipamentos" | "Equipamentos da troca" | "Horímetros / KM" | "Central de alertas" | "Histórico" | "Status da Frota" | "Controle Diário"
  | "Solicitação de Materiais" | "Produtos" | "Combustível" | "Funcionários" | "Tarefas" | "Usuários" | "Movimentação" | "Ordem de Serviço"
  | "Solicitação de Pedidos" | "Terceiros" | "Pendências" | "Custos e Consumo" | "Pneus e Baterias";
export type ViewCatalogo = {
  view: string;
  titulo: string;
  modulo: string;
  descricao: string;
  escopo: "frente" | "global" | "usuario" | "admin";
  colunasFrente?: readonly string[];
  colunasUsuario?: readonly string[];
  // Coluna usada pelo "período" da consulta. eventos = sem período informado, vale o mês atual.
  colunaData?: string;
  eventos?: boolean;
  permissoes?: readonly Permission[];
  perfis?: readonly Profile[];
  tela?: SecaoTela;
  // Colunas mostradas quando a consulta não escolhe colunas.
  padrao: readonly string[];
  dica?: string;
  colunas: readonly ColunaCatalogo[];
};

const t = (nome: string, descricao: string, valores?: readonly string[]): ColunaCatalogo => ({ nome, tipo: "texto", descricao, ...(valores ? { valores } : {}) });
const n = (nome: string, descricao: string): ColunaCatalogo => ({ nome, tipo: "numero", descricao });
const d = (nome: string, descricao: string): ColunaCatalogo => ({ nome, tipo: "data", descricao });
const b = (nome: string, descricao: string): ColunaCatalogo => ({ nome, tipo: "sim_nao", descricao });
const frente = [n("frente_id", "Id interno da frente (use o nome em frente)"), t("frente", "Frente de serviço")] as const;
const equipamento = [n("equipamento_id", "Id interno do equipamento"), t("equipamento", "Código do equipamento (ex.: CM-22)"), t("tipo_equipamento", "Tipo do equipamento (Caminhão, Escavadeira...)")] as const;

const STATUS_FROTA = ["Operando", "Parado", "Em manutenção", "Aguardando peça", "Aguardando pedido", "Aguardando mecânico", "Aguardando serviço externo", "Liberado / pronto", "Inativo"] as const;
const SITUACAO_TROCA = ["Normal", "Próxima", "Vencida", "Vencida (urgente)", "Sem histórico", "Sem plano"] as const;
const SITUACAO_PEDIDO = ["Aguardando aprovação", "Recusado", "Aprovado / Em cotação", "Análise de pagamento", "Pago", "Enviado", "Recebido", "Cancelado", "Em andamento"] as const;
const EQUIP_PERMS = ["equipment.view", "fleet.view", "maintenance.view", "fuel.view", "work_orders.view"] as const satisfies readonly Permission[];
const OLEO_PERMS = ["maintenance.view", "maintenance.history", "alerts.view", "equipment.view"] as const satisfies readonly Permission[];
const GESTAO: readonly Profile[] = ["ADMIN", "GESTOR"];

export const CATALOGO: readonly ViewCatalogo[] = [
  {
    view: "v_frentes", titulo: "Frentes de serviço", modulo: "Cadastros", escopo: "frente", padrao: ["frente", "local", "ativa"],
    descricao: "Frentes de serviço (Arapiuns, Mamuru...).",
    colunas: [...frente, t("local", "Local / município"), b("ativa", "Frente ativa")],
  },
  {
    view: "v_equipamentos", titulo: "Equipamentos da frota", modulo: "Equipamentos", escopo: "frente", permissoes: EQUIP_PERMS, tela: "Equipamentos",
    descricao: "Cadastro da frota JC com frente, situação, status da frota, proprietário e leitura atual de horímetro/KM. Inclui vendidos (vendido = sim).",
    padrao: ["codigo", "placa", "tipo", "marca", "modelo", "frente", "situacao_cadastro", "status_frota", "horimetro_atual", "km_atual", "data_ultima_leitura"],
    dica: "Para a frota em uso filtre vendido = false.",
    colunas: [
      n("equipamento_id", "Id interno"), t("codigo", "Código/prefixo (CM-22, SK-02, PC-27...)"), t("placa", "Placa"), t("chassi_serie", "Chassi ou número de série"),
      t("tipo", "Tipo (Caminhão, Skidder, Escavadeira...)"), t("marca", "Marca"), t("modelo", "Modelo"), t("modelo_aplicacao", "Modelo usado na aplicação de peças"), n("ano", "Ano"),
      ...frente, t("local", "Local informado no cadastro"),
      t("situacao_cadastro", "Situação no cadastro", ["Ativo", "Parado", "Em manutenção", "Inativo"]), t("status_frota", "Status atual no Status da Frota", STATUS_FROTA),
      t("proprietario", "Empresa em cujo nome está registrado"), t("controle", "Tipo de leitura", ["KM", "Horímetro", "Horímetro e KM"]),
      n("horimetro_atual", "Horímetro atual (h)"), n("km_atual", "Hodômetro atual (km)"), d("data_ultima_leitura", "Data da última leitura registrada"),
      b("participa_troca_oleo", "Participa do módulo Troca de Óleo"), b("vendido", "Equipamento vendido"), d("data_venda", "Data da venda"), d("vencimento_ipva", "Vencimento do IPVA"),
    ],
  },
  {
    view: "v_leituras", titulo: "Leituras de horímetro/KM", modulo: "Equipamentos", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["meter.view", "equipment.view"], tela: "Horímetros / KM",
    descricao: "Histórico de leituras de horímetro e KM dos equipamentos.", padrao: ["data", "equipamento", "frente", "horimetro", "km", "operador", "origem"],
    colunas: [n("leitura_id", "Id"), d("data", "Data da leitura"), ...equipamento, ...frente, n("horimetro", "Horímetro (h)"), n("km", "Hodômetro (km)"), t("operador", "Quem informou"),
      t("origem", "Como foi registrada", ["Manual", "Planilha", "QR Code", "Troca de óleo", "Assistente JC", "Controle Diário"]), b("regressao_autorizada", "Leitura menor que a anterior aceita"), t("observacao", "Observação"),
      n("registro_diario_id", "Id do registro do Controle Diário (quando veio de lá)")],
  },
  {
    view: "v_trocas_oleo", titulo: "Situação das trocas de óleo", modulo: "Troca de Óleo", escopo: "frente", permissoes: OLEO_PERMS, tela: "Central de alertas",
    descricao: "Retrato atual de cada plano de troca (equipamento × serviço): última troca, próxima prevista, quanto falta e situação — mesma regra da Central de alertas.",
    padrao: ["equipamento", "frente", "servico", "unidade", "leitura_atual", "proxima_troca_leitura", "faltam", "vencida_ha", "situacao"],
    dica: "Trocas vencidas: situacao em ('Vencida','Vencida (urgente)'). Próximas: situacao = 'Próxima'.",
    colunas: [n("plano_id", "Id do plano"), ...equipamento, ...frente, t("servico", "Serviço (Troca de óleo do motor, Filtro...)"), t("unidade", "Unidade da leitura", ["h", "km"]),
      n("leitura_atual", "Leitura atual"), n("ultima_troca_leitura", "Leitura da última troca"), d("ultima_troca_data", "Data da última troca"), n("intervalo", "Intervalo do plano"),
      n("proxima_troca_leitura", "Leitura prevista da próxima troca"), n("faltam", "Quanto falta (negativo = vencida)"), n("vencida_ha", "Quanto passou do previsto"),
      t("situacao", "Situação", SITUACAO_TROCA), n("saude_percentual", "Saúde do plano em % (100 = acabou de trocar, 0 = vencida)")],
  },
  {
    view: "v_planos_manutencao", titulo: "Planos de manutenção (configuração)", modulo: "Troca de Óleo", escopo: "frente", permissoes: OLEO_PERMS, tela: "Equipamentos da troca",
    descricao: "Configuração de cada plano: gatilho, intervalos, última e próxima troca, tipo de óleo, viscosidade, marca, filtro e quantidade prevista.",
    padrao: ["equipamento", "frente", "servico", "gatilho", "intervalo_horas", "intervalo_km", "tipo_oleo", "viscosidade", "referencia_filtro", "quantidade_prevista"],
    colunas: [n("plano_id", "Id"), ...equipamento, ...frente, t("servico", "Serviço"), t("categoria", "Categoria do serviço"), t("gatilho", "O que dispara a troca", ["Horímetro", "KM", "Tempo", "Horímetro ou tempo", "KM ou tempo"]),
      n("intervalo_horas", "Intervalo em horas"), n("intervalo_km", "Intervalo em km"), n("intervalo_dias", "Intervalo em dias"), n("ultima_horas", "Horímetro da última troca"), n("ultima_km", "KM da última troca"),
      d("ultima_data", "Data da última troca"), n("proxima_horas", "Horímetro previsto"), n("proxima_km", "KM previsto"), d("proxima_data", "Data prevista"), t("tipo_oleo", "Tipo de óleo"),
      t("viscosidade", "Viscosidade"), t("marca_oleo", "Marca do óleo"), t("referencia_filtro", "Referência do filtro"), n("quantidade_prevista", "Quantidade prevista (L)"), t("observacao", "Observação"), b("ativo", "Plano ativo")],
  },
  {
    view: "v_trocas_realizadas", titulo: "Trocas e manutenções realizadas", modulo: "Troca de Óleo", escopo: "frente", colunaData: "data", eventos: true, permissoes: OLEO_PERMS, tela: "Histórico",
    descricao: "Histórico de trocas/manutenções feitas: as registradas no sistema e as importadas de planilha (origem).",
    padrao: ["data", "equipamento", "frente", "servico", "leitura_horimetro", "leitura_km", "mecanico", "ordem_servico", "custo", "origem"],
    colunas: [t("registro", "Identificador"), d("data", "Data da troca"), ...equipamento, ...frente, t("servico", "Serviço"), n("leitura_horimetro", "Horímetro na troca"), n("leitura_km", "KM na troca"),
      t("mecanico", "Mecânico"), t("ordem_servico", "Número de OS informado"), t("os_sistema", "O.S. do sistema vinculada (OS-000123)"), n("custo", "Custo informado (R$)"), t("observacao", "Observação"),
      t("origem", "Origem do registro", ["Sistema", "Planilha importada (histórico)"]), b("data_generica", "Data genérica da importação (não é a data real)")],
  },
  {
    view: "v_alertas", titulo: "Alertas de manutenção abertos", modulo: "Troca de Óleo", escopo: "frente", permissoes: OLEO_PERMS, tela: "Central de alertas",
    descricao: "Alertas de troca ainda abertos (não fechados por uma troca).", padrao: ["gerado_em", "equipamento", "frente", "servico", "nivel", "faltam", "vencida_ha", "unidade", "mensagem"],
    colunas: [n("alerta_id", "Id"), d("gerado_em", "Quando o alerta foi gerado"), n("equipamento_id", "Id do equipamento"), t("equipamento", "Código do equipamento"), ...frente, t("servico", "Serviço"),
      t("nivel", "Nível", ["Atenção", "Vencida", "Urgente", "Crítico", "Normal"]), t("situacao", "Situação do alerta", ["Aberto", "Visto"]), t("unidade", "Unidade", ["h", "km"]),
      n("leitura_atual", "Leitura atual"), n("leitura_prevista", "Leitura prevista"), n("faltam", "Quanto falta"), n("vencida_ha", "Quanto passou"), t("mensagem", "Mensagem do alerta")],
  },
  {
    view: "v_ordens_servico", titulo: "Ordens de serviço", modulo: "Ordem de Serviço", escopo: "frente", colunaData: "aberta_em", eventos: true, permissoes: ["work_orders.view"], tela: "Ordem de Serviço",
    descricao: "O.S. abertas e fechadas, com mecânicos, peças lançadas (quantidade de itens e valor) e trocas vinculadas.",
    padrao: ["numero", "aberta_em", "equipamento", "frente", "situacao", "descricao", "mecanicos", "pecas_valor", "dias_aberta"],
    dica: "O.S. em aberto: situacao = 'Aberta' (use periodo 'todo' para ver as antigas ainda abertas).",
    colunas: [n("os_id", "Id"), t("numero", "Número (OS-000123)"), d("aberta_em", "Data de abertura"), ...equipamento, ...frente, t("situacao", "Situação", ["Aberta", "Fechada"]), d("fechada_em", "Data de fechamento"),
      t("descricao", "Serviço/diagnóstico"), n("leitura", "Leitura na abertura"), t("unidade", "Unidade", ["h", "km"]), t("mecanicos", "Mecânicos"), n("pecas_itens", "Peças lançadas (itens)"),
      n("pecas_valor", "Valor das peças (R$)"), n("trocas_vinculadas", "Trocas de óleo vinculadas"), n("dias_aberta", "Dias em aberto (só abertas)"), t("observacao_fechamento", "Observação do fechamento")],
  },
  {
    view: "v_pneus_baterias", titulo: "Pneus e baterias", modulo: "Pneus e Baterias", escopo: "frente", permissoes: ["equipment.view"], tela: "Pneus e Baterias",
    descricao: "Cada pneu (número de fogo) e bateria: situação, onde está montado, uso acumulado, recapagens e custos. Itens em estoque não têm frente.",
    padrao: ["tipo", "numero", "marca", "medida", "situacao", "equipamento", "posicao", "uso_km", "uso_horas", "recapagens"],
    colunas: [n("item_id", "Id"), t("tipo", "Tipo", ["Pneu", "Bateria"]), t("numero", "Número de fogo / série"), t("marca", "Marca"), t("modelo", "Modelo"), t("medida", "Medida"),
      t("situacao", "Situação", ["Em estoque", "Montado", "Descartado"]), n("equipamento_id", "Id do equipamento"), t("equipamento", "Equipamento onde está montado"), ...frente, t("posicao", "Posição"),
      d("montado_em", "Data de montagem"), n("uso_km", "Uso acumulado (km)"), n("uso_horas", "Uso acumulado (h)"), n("vida_esperada", "Vida esperada (km/h para pneu, meses para bateria)"),
      n("recapagens", "Recapagens"), n("ultimo_sulco_mm", "Último sulco medido (mm)"), d("data_compra", "Data da compra"), n("custo_compra", "Custo de compra (R$)"),
      n("custo_eventos", "Custo de recapagens/consertos (R$)"), t("fornecedor", "Fornecedor"), n("garantia_meses", "Garantia (meses)")],
  },
  {
    view: "v_status_frota", titulo: "Status atual da frota", modulo: "Status da Frota", escopo: "frente", permissoes: ["fleet.view"], tela: "Status da Frota",
    descricao: "Status atual de cada equipamento (operando, parado, em manutenção, aguardando peça...) e há quanto tempo.",
    padrao: ["equipamento", "tipo_equipamento", "frente", "status", "desde", "horas_no_status", "motivo", "problema"],
    colunas: [...equipamento, ...frente, t("status", "Status", STATUS_FROTA), b("parado", "Está parado (qualquer status diferente de operando/liberado/inativo)"), d("desde", "Desde quando"),
      n("horas_no_status", "Horas no status atual"), t("motivo", "Motivo da parada"), t("problema", "Problema"), t("local_ocorrencia", "Local da ocorrência")],
  },
  {
    view: "v_paradas_frota", titulo: "Paradas de equipamentos", modulo: "Status da Frota", escopo: "frente", colunaData: "inicio", eventos: true, permissoes: ["fleet.view"], tela: "Status da Frota",
    descricao: "Ocorrências de parada (início, fim, horas parado, motivo, serviço e peças).", padrao: ["inicio", "fim", "equipamento", "frente", "horas_parado", "motivo", "problema", "em_aberto"],
    colunas: [t("ocorrencia_id", "Id"), ...equipamento, ...frente, d("inicio", "Início da parada"), d("fim", "Volta à operação"), b("em_aberto", "Ainda parado"), n("horas_parado", "Horas parado"),
      t("motivo", "Motivo"), t("problema", "Problema"), t("servico_realizado", "Serviço realizado"), t("pecas_usadas", "Peças usadas"), t("local", "Local"), t("observacao", "Observação")],
  },
  {
    view: "v_transferencias_equipamentos", titulo: "Transferências de equipamentos", modulo: "Equipamentos", escopo: "frente", colunasFrente: ["frente_id", "frente_origem_id"], colunaData: "data", eventos: true,
    permissoes: ["equipment.view"], tela: "Equipamentos",
    descricao: "Transferências de equipamentos entre frentes (frente = destino).", padrao: ["data", "equipamento", "frente_origem", "frente", "transferido_por", "observacao"],
    colunas: [t("transferencia_id", "Id"), d("data", "Data"), n("equipamento_id", "Id do equipamento"), t("equipamento", "Código"), n("frente_origem_id", "Id da frente de origem"), t("frente_origem", "Frente de origem"),
      n("frente_id", "Id da frente de destino"), t("frente", "Frente de destino"), t("transferido_por", "Quem transferiu"), t("observacao", "Observação")],
  },
  {
    view: "v_combustivel_movimentacoes", titulo: "Lançamentos de combustível", modulo: "Combustível", escopo: "frente", colunasFrente: ["frente_id", "frente_destino_id"], colunaData: "data", eventos: true,
    permissoes: ["fuel.view"], tela: "Combustível",
    descricao: "Entradas, saídas e transferências de combustível (sem excluídos e sem ajustes de saldo). Na saída: frota JC (equipamento), terceiro ou prestador (empresa/placa), com leitura e consumo calculado entre tanques cheios.",
    padrao: ["data", "frente", "estoque", "combustivel", "tipo", "tipo_saida", "equipamento", "placa", "empresa", "litros", "leitura", "consumo", "unidade_consumo", "responsavel"],
    dica: "Diesel que saiu: tipo = 'Saída' (some litros). Transferência sai da frente de origem e entra em frente_destino. Média de consumo de um grupo = soma(rodado) ÷ soma(litros_do_consumo) (km/L) — prefira a ferramenta consumo_veiculo para médias. Saída para terceiro: destino_terceiro 'Veículo' (placa, com leitura e consumo) ou 'Funcionário' (funcionario_terceiro + finalidade, sem leitura e fora de qualquer média) — 'diesel que a empresa pegou fora dos caminhões/veículos' = destino_terceiro 'Funcionário'. tipo_saida 'Veículo a identificar' = abastecimento importado sem o veículo identificado (o texto original está em veiculo_planilha): mostre separado e avise que precisa ser identificado no Histórico do Combustível.",
    colunas: [n("lancamento_id", "Id"), d("data", "Data"), ...frente, t("estoque", "Estoque", ["Frente", "Porto"]), t("combustivel", "Combustível (Diesel S10, Gasolina Comum...)"),
      t("tipo", "Tipo do lançamento", ["Entrada", "Saída", "Transferência"]), t("tipo_saida", "Para quem saiu", ["Frota JC", "Terceiro", "Prestador de serviço", "Veículo a identificar", "Sem veículo"]),
      n("frente_destino_id", "Id da frente de destino (transferência)"), t("frente_destino", "Frente de destino (transferência)"), t("estoque_destino", "Estoque de destino", ["Frente", "Porto"]),
      ...equipamento, n("veiculo_terceiro_id", "Id do veículo de terceiro"), t("placa_terceiro", "Placa do veículo de terceiro"), t("empresa", "Empresa (terceiro/prestador)"), t("placa", "Placa (frota ou terceiro)"),
      t("equipamento_prestador", "Equipamento do prestador (texto)"), n("litros", "Litros"), n("valor_litro", "Valor por litro na entrada (R$)"), n("valor_entrada", "Valor da entrada (R$)"),
      n("leitura", "Leitura no abastecimento"), t("unidade_leitura", "Unidade da leitura", ["km", "h"]), n("rodado", "Rodado desde o último tanque cheio (km ou h)"),
      n("litros_do_consumo", "Litros usados no cálculo do consumo"), n("consumo", "Consumo do abastecimento"), t("unidade_consumo", "Unidade do consumo", ["km/L", "L/h"]),
      b("tanque_cheio", "Tanque cheio"), b("consumo_fora_da_media", "Consumo desviou mais de 25% da média"), b("veiculo_pendente", "Veículo ainda não identificado"),
      t("responsavel", "Motorista/responsável"), t("observacao", "Observação"), t("origem_registro", "Origem", ["Lançamento", "Assistente JC", "Importação de planilha", "Histórico importado"]),
      t("veiculo_planilha", "Veículo como veio na planilha importada (quando o veículo está a identificar)"), n("terceiro_id", "Id do terceiro"),
      t("destino_terceiro", "Destino na empresa terceira", ["Veículo", "Funcionário", "Não informado"]), n("funcionario_terceiro_id", "Id do funcionário do terceiro"),
      t("funcionario_terceiro", "Funcionário do terceiro que recebeu (destino Funcionário)"), t("finalidade", "Finalidade (destino Funcionário): Motosserra, Gerador, Galão / reserva, Máquina não cadastrada, Outros: ...")],
  },
  {
    view: "v_combustivel_saldos", titulo: "Saldo atual de combustível", modulo: "Combustível", escopo: "frente", permissoes: ["fuel.view"], tela: "Combustível",
    descricao: "Saldo de hoje por frente, estoque (Frente/Porto) e combustível — tudo que entrou menos tudo que saiu, com ajustes de saldo. Inclui capacidade do tanque e a última medição física.",
    padrao: ["frente", "estoque", "combustivel", "saldo_litros", "data_ultimo_lancamento", "capacidade_tanque_litros", "data_ultima_medicao", "litros_ultima_medicao"],
    dica: "Saldo de diesel por frente: filtre combustivel contém 'diesel' e some saldo_litros agrupando por frente (Frente + Porto).",
    colunas: [...frente, t("estoque", "Estoque", ["Frente", "Porto"]), t("combustivel", "Combustível"), n("saldo_litros", "Saldo atual (L)"), d("data_ultimo_lancamento", "Data do último lançamento"),
      n("capacidade_tanque_litros", "Capacidade do tanque (L)"), d("data_ultima_medicao", "Data da última medição física"), n("litros_ultima_medicao", "Litros medidos"), n("diferenca_ultima_medicao", "Diferença medido − sistema (L)")],
  },
  {
    view: "v_combustivel_medicoes", titulo: "Medições de tanque", modulo: "Combustível", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["fuel.view"], tela: "Combustível",
    descricao: "Conciliação do tanque: litros medidos × saldo do sistema na hora, diferença e tolerância.", padrao: ["data", "frente", "estoque", "combustivel", "litros_medidos", "litros_sistema", "diferenca_litros", "dentro_da_tolerancia"],
    colunas: [n("medicao_id", "Id"), d("data", "Data"), ...frente, t("estoque", "Estoque", ["Frente", "Porto"]), t("combustivel", "Combustível"), t("metodo", "Método", ["Litros", "Régua"]), n("regua_cm", "Régua (cm)"),
      n("litros_medidos", "Litros medidos"), n("litros_sistema", "Saldo do sistema na hora"), n("diferenca_litros", "Diferença (L)"), n("tolerancia_percentual", "Tolerância (%)"),
      b("dentro_da_tolerancia", "Dentro da tolerância"), b("gerou_ajuste", "Gerou ajuste de saldo"), t("observacao", "Observação")],
  },
  {
    view: "v_terceiros", titulo: "Terceiros (empresas e prestadores)", modulo: "Terceiros", escopo: "global", permissoes: ["fuel.view", "stock.exits_view", "third_parties.manage"], tela: "Terceiros",
    descricao: "Cadastro único de terceiros: prestadores, terceirizadas e pessoas físicas (sem CPF).", padrao: ["empresa", "tipo", "cnpj", "contato", "telefone", "frente_principal", "ativo", "veiculos_ativos"],
    colunas: [n("terceiro_id", "Id"), t("empresa", "Nome"), t("tipo", "Tipo", ["Prestador de serviço", "Terceirizada", "Pessoa física"]), t("cnpj", "CNPJ (vazio para pessoa física)"), t("contato", "Contato"),
      t("telefone", "Telefone"), n("frente_principal_id", "Id da frente principal"), t("frente_principal", "Frente principal"), b("ativo", "Ativo"), n("veiculos_ativos", "Veículos ativos"), t("observacao", "Observação")],
  },
  {
    view: "v_funcionarios_terceiros", titulo: "Funcionários de terceiros", modulo: "Terceiros", escopo: "global", permissoes: ["fuel.view", "stock.exits_view", "third_parties.manage"], tela: "Terceiros",
    descricao: "Funcionários de cada empresa terceira/prestador (quem recebe combustível para motosserra, gerador, galão... ou peças fora dos veículos). Sem CPF.",
    padrao: ["empresa", "nome", "funcao", "telefone", "ativo"],
    colunas: [n("funcionario_id", "Id"), n("terceiro_id", "Id do terceiro"), t("empresa", "Empresa"), t("tipo_empresa", "Tipo da empresa", ["Prestador de serviço", "Terceirizada", "Pessoa física"]),
      t("nome", "Nome do funcionário"), t("funcao", "Função"), t("telefone", "Telefone"), b("ativo", "Ativo"), b("pode_receber", "Empresa e funcionário ativos")],
  },
  {
    view: "v_terceiros_resumo_mensal", titulo: "Resumo de terceiros por mês", modulo: "Terceiros", escopo: "frente", colunaData: "mes", eventos: true, permissoes: ["fuel.view", "stock.exits_view", "third_parties.manage"], tela: "Terceiros",
    descricao: "Por empresa terceira, mês e frente: litros de combustível nos veículos dela x entregues a funcionários dela (motosserra, gerador, galão...) e valor das peças em veículos x para funcionários.",
    padrao: ["mes", "empresa", "frente", "litros_em_veiculos", "litros_para_funcionarios", "litros_total", "valor_pecas_em_veiculos", "valor_pecas_para_funcionarios", "valor_pecas_total"],
    dica: "Ex.: 'quanto de diesel a GREGOLETO pegou fora dos caminhões em setembro' = diesel_para_funcionarios (ou, com detalhe por funcionário/finalidade, v_combustivel_movimentacoes com destino_terceiro = 'Funcionário' e combustivel contém 'diesel'). Valor do combustível em R$ (custo médio) está em Terceiros → Resumo por empresa.",
    colunas: [d("mes", "Mês (primeiro dia)"), n("ano", "Ano"), n("terceiro_id", "Id do terceiro"), t("empresa", "Empresa"), t("tipo_empresa", "Tipo da empresa", ["Prestador de serviço", "Terceirizada", "Pessoa física"]), ...frente,
      n("litros_em_veiculos", "Combustível nos veículos da empresa (L)"), n("litros_para_funcionarios", "Combustível entregue a funcionários da empresa (L)"),
      n("diesel_para_funcionarios", "Diesel entregue a funcionários da empresa (L)"), n("litros_sem_destino", "Combustível sem destino informado (L, lançamentos antigos)"), n("litros_total", "Combustível total (L)"),
      n("valor_pecas_em_veiculos", "Peças nos veículos da empresa (R$)"), n("valor_pecas_para_funcionarios", "Peças para funcionários da empresa (R$)"),
      n("valor_pecas_sem_destino", "Peças sem destino informado (R$)"), n("valor_pecas_total", "Peças total (R$)"), n("quantidade_pecas", "Quantidade de peças")],
  },
  {
    view: "v_veiculos_terceiros", titulo: "Veículos de terceiros e consumo", modulo: "Terceiros", escopo: "frente", permissoes: ["fuel.view", "stock.exits_view", "third_parties.manage"], tela: "Terceiros",
    descricao: "Um registro por veículo de terceiro e frente onde abasteceu (desde sempre): litros, rodado e consumo médio. Veículo sem abastecimento aparece sem frente.",
    padrao: ["empresa", "placa", "descricao", "tipo_veiculo", "frente", "abastecimentos", "litros_abastecidos", "consumo_medio", "unidade_consumo", "consumo_esperado", "ultimo_abastecimento"],
    dica: "Média de uma empresa = soma(rodado_com_consumo) ÷ soma(litros_com_consumo). Para um período específico, prefira a ferramenta consumo_veiculo.",
    colunas: [n("veiculo_id", "Id"), n("terceiro_id", "Id do terceiro"), t("empresa", "Empresa"), t("tipo_empresa", "Tipo da empresa", ["Prestador de serviço", "Terceirizada", "Pessoa física"]), t("placa", "Placa/identificação"),
      t("descricao", "Descrição"), t("tipo_veiculo", "Tipo", ["Caminhão", "Máquina", "Veículo leve", "Outro"]), t("medidor", "Medidor", ["km", "h"]), t("combustivel", "Combustível"),
      n("capacidade_tanque_litros", "Capacidade do tanque (L)"), n("consumo_esperado", "Consumo esperado (km/L ou L/h)"), n("ultima_leitura_cadastro", "Última leitura no cadastro"), b("ativo", "Ativo"),
      ...frente, n("abastecimentos", "Abastecimentos"), n("litros_abastecidos", "Litros abastecidos"), n("rodado_com_consumo", "Rodado considerado no consumo"), n("litros_com_consumo", "Litros considerados no consumo"),
      n("consumo_medio", "Consumo médio"), t("unidade_consumo", "Unidade", ["km/L", "L/h"]), d("ultimo_abastecimento", "Último abastecimento")],
  },
  {
    view: "v_custos_consumo", titulo: "Custos e consumo por equipamento/mês", modulo: "Custos e Consumo", escopo: "frente", colunaData: "mes", eventos: true, perfis: GESTAO, tela: "Custos e Consumo",
    descricao: "Por equipamento da frota, mês e frente: litros de combustível, consumo médio, valor das peças (saídas de estoque, sem Correção de Estoque) e das trocas/manutenções. Valor do combustível em R$ não está aqui (use consumo_veiculo).",
    padrao: ["mes", "equipamento", "frente", "litros_combustivel", "consumo_medio", "unidade_consumo", "valor_pecas", "valor_manutencoes", "valor_pecas_e_manutencoes"],
    colunas: [d("mes", "Mês (primeiro dia)"), n("ano", "Ano"), ...equipamento, ...frente, n("litros_combustivel", "Litros de combustível"), n("consumo_medio", "Consumo médio"), t("unidade_consumo", "Unidade", ["km/L", "L/h"]),
      n("valor_pecas", "Valor das peças (R$)"), n("valor_manutencoes", "Valor das trocas/manutenções (R$)"), n("trocas", "Trocas realizadas"), n("valor_pecas_e_manutencoes", "Peças + manutenções (R$)")],
  },
  {
    view: "v_produtos", titulo: "Produtos e saldo em estoque", modulo: "Produtos", escopo: "frente", permissoes: ["products.view"], tela: "Produtos",
    descricao: "Produtos ativos em cada frente com saldo atual, valor em estoque, saída média mensal (últimos 90 dias) e situação do estoque.",
    padrao: ["tag", "nome", "referencia", "marca", "frente", "saldo", "preco", "saida_media_mensal", "cobertura_meses", "situacao_estoque"],
    dica: "Estoque zerado/baixo (o que precisa repor): situacao_estoque em ('Zerado','Negativo','Baixo'). Zerado = saldo zero com saída nos últimos 90 dias; saldo zero sem uso recente é 'Zerado sem saída recente' (só cite como total, se pedirem). Baixo = saldo menor que 1 mês de saída média. Não existe estoque mínimo cadastrado.",
    colunas: [n("produto_id", "Id"), t("tag", "TAG"), t("nome", "Nome"), t("referencia", "Referência(s)"), t("marca", "Marca"), t("fornecedor", "Fornecedor"), t("aplicacao", "Modelos de equipamento em que se aplica"),
      n("preco", "Preço (R$)"), b("cadastro_para_revisar", "Cadastro marcado para revisão"), b("produto_ativo", "Produto ativo"), ...frente, n("saldo", "Saldo atual na frente"),
      n("valor_em_estoque", "Saldo × preço (R$)"), n("saida_90_dias", "Saídas nos últimos 90 dias"), n("saida_media_mensal", "Saída média por mês"), n("cobertura_meses", "Meses que o saldo cobre"),
      t("situacao_estoque", "Situação", ["OK", "Baixo", "Zerado", "Negativo", "Sem saída recente", "Zerado sem saída recente"])],
  },
  {
    view: "v_produtos_movimentacoes", titulo: "Movimentações de produtos", modulo: "Produtos", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["products.view", "stock.exits_view"], tela: "Movimentação",
    descricao: "Toda entrada e saída de produto (sem estornadas): Movimentação, O.S., Solicitação de Materiais, compras, ajustes e o histórico importado do sistema antigo.",
    padrao: ["data", "frente", "tipo", "origem", "documento", "tag", "produto", "quantidade", "valor_unitario", "valor_total", "equipamento", "colaborador", "departamento"],
    dica: "Consumo/saídas: tipo = 'Saída' (não inclui 'Correção de estoque'). importado_sistema_antigo = sim são lançamentos do almoxarifado antigo (jan–out/2026) que entraram só como histórico (baixou_estoque = não). Departamentos do sistema antigo foram unificados: 'Setor de Alimentação e Refeições' = ALIMENTAÇÃO, 'Manutenção e Gestão da Frota' = MANUTENÇÃO DA FROTA, 'Gestão de Alojamentos' = ALOJAMENTO (o nome antigo fica em departamento_planilha). Filtre departamento com contem e parte do nome.",
    colunas: [n("movimento_id", "Id"), d("data", "Data"), ...frente, t("tipo", "Tipo", ["Entrada", "Saída", "Correção de estoque", "Ajuste de saldo"]),
      t("origem", "De onde veio", ["Movimentação", "Movimentação (Assistente JC)", "Ordem de Serviço", "Solicitação de Materiais", "Pedido de compra", "Ajuste manual", "Sistema antigo (importado)"]),
      t("documento", "Documento (SAI-, OS-, SOL-, PED-, IMP-)"), n("produto_id", "Id do produto"), t("tag", "TAG"), t("produto", "Nome do produto"), n("quantidade", "Quantidade"), b("e_entrada", "É entrada"),
      n("valor_unitario", "Valor unitário (R$)"), n("valor_total", "Valor total (R$)"), n("equipamento_id", "Id do equipamento"), t("equipamento", "Equipamento (código ou texto do sistema antigo)"),
      t("terceiro", "Terceiro/prestador"), t("colaborador", "Funcionário/quem retirou"), t("departamento", "Departamento (cadastro do sistema)"),
      t("departamento_planilha", "Departamento como veio da planilha do sistema antigo"), t("local_destino", "Local/destino (sistema antigo)"),
      t("proprietario_equipamento", "Proprietário do equipamento (sistema antigo)"), t("aplicacao_peca", "Onde a peça foi aplicada (O.S.)"), b("importado_sistema_antigo", "Importado do sistema antigo"),
      b("baixou_estoque", "Alterou o saldo"), t("situacao_os", "Situação da O.S.", ["Aberta", "Fechada"]), t("motivo", "Motivo registrado"),
      n("terceiro_id", "Id do terceiro"), t("placa_terceiro", "Placa do veículo do terceiro"), t("destino_terceiro", "Destino na empresa terceira", ["Veículo", "Funcionário", "Não informado"]),
      n("funcionario_terceiro_id", "Id do funcionário do terceiro"), t("funcionario_terceiro", "Funcionário do terceiro (destino Funcionário)"), t("recebido_por", "Recebido por (saída para terceiro)")],
  },
  {
    view: "v_solicitacoes_materiais", titulo: "Solicitações de materiais", modulo: "Solicitação de Materiais", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["materials.view"], tela: "Solicitação de Materiais",
    descricao: "Pedidos de material entre frentes, um registro por item.", padrao: ["numero", "data", "frente", "solicitante", "situacao", "item", "quantidade_pedida", "quantidade_enviada", "situacao_item"],
    colunas: [n("solicitacao_id", "Id"), t("numero", "Número (SOL-000123)"), d("data", "Data"), ...frente, t("solicitante", "Solicitante"),
      t("situacao", "Situação", ["Pendente", "Em separação", "Enviada", "Enviada parcialmente", "Não atendida", "Cancelada"]), t("item", "Item"), t("referencia", "Referência"), t("tag_produto", "TAG do produto"),
      n("quantidade_pedida", "Quantidade pedida"), n("quantidade_enviada", "Quantidade enviada"), t("unidade", "Unidade"), t("situacao_item", "Situação do item", ["Pendente", "Enviado", "Indisponível"]),
      d("enviada_em", "Data do envio"), t("frente_origem_envio", "Frente de onde saiu")],
  },
  {
    view: "v_pedidos_compra", titulo: "Pedidos de compra", modulo: "Solicitação de Pedidos", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["purchases.view"], tela: "Solicitação de Pedidos",
    descricao: "Solicitações de compra (PED-), um registro por item, com situação, valores e fornecedor.", padrao: ["numero", "data", "frente", "solicitante", "situacao_pedido", "item", "quantidade", "valor_total", "fornecedor"],
    colunas: [n("pedido_id", "Id"), t("numero", "Número (PED-000123)"), d("data", "Data do pedido"), ...frente, t("solicitante", "Solicitante"), t("departamento", "Departamento"), t("titulo", "Título"),
      t("urgencia", "Urgência", ["Baixa", "Normal", "Alta", "Urgente"]), t("situacao_pedido", "Situação do pedido", SITUACAO_PEDIDO), t("item", "Item"), t("tag_produto", "TAG do produto"), n("quantidade", "Quantidade"),
      t("unidade", "Unidade"), t("situacao_item", "Situação do item", [...SITUACAO_PEDIDO.filter((value) => value !== "Em andamento"), "Removido na cotação"]), n("valor_unitario", "Valor unitário (R$)"),
      n("valor_total", "Valor total (R$)"), t("fornecedor", "Fornecedor"), t("marca", "Marca"), t("equipamento", "Equipamento"), d("pago_em", "Data do pagamento"), d("recebido_em", "Data do recebimento")],
  },
  {
    view: "v_fornecedores", titulo: "Fornecedores", modulo: "Produtos", escopo: "global", permissoes: ["suppliers.view", "products.view"], tela: "Produtos",
    descricao: "Cadastro de fornecedores.", padrao: ["fornecedor", "cnpj", "telefone", "email", "ativo"],
    colunas: [n("fornecedor_id", "Id"), t("fornecedor", "Nome"), t("cnpj", "CNPJ"), t("telefone", "Telefone"), t("email", "E-mail"), b("ativo", "Ativo")],
  },
  {
    view: "v_funcionarios", titulo: "Funcionários", modulo: "Funcionários", escopo: "frente", permissoes: ["employees.view"], tela: "Funcionários",
    descricao: "Funcionários com função, empresa, frente e situação (sem CPF, nascimento e salário).", padrao: ["nome", "funcao", "empresa", "frente", "situacao", "admissao"],
    colunas: [n("funcionario_id", "Id"), t("nome", "Nome"), t("funcao", "Função"), t("empresa", "Empresa"), d("admissao", "Admissão"), ...frente, t("situacao", "Situação", ["Ativo", "De folga", "Afastado", "Demitido"]),
      t("matricula", "Matrícula"), t("cidade", "Cidade"), n("ciclo_dias_trabalho", "Dias de trabalho do ciclo"), n("ciclo_dias_folga", "Dias de folga do ciclo")],
  },
  {
    view: "v_ausencias_funcionarios", titulo: "Ausências de funcionários", modulo: "Funcionários", escopo: "frente", colunaData: "inicio", eventos: true, permissoes: ["employees.view"], tela: "Funcionários",
    descricao: "Folgas, férias, atestados e afastamentos.", padrao: ["funcionario", "frente", "tipo", "inicio", "fim", "em_aberto"],
    colunas: [n("ausencia_id", "Id"), n("funcionario_id", "Id do funcionário"), t("funcionario", "Funcionário"), ...frente, t("tipo", "Tipo", ["Folga", "Férias", "Atestado médico", "Afastamento", "Outro"]),
      d("inicio", "Início"), d("fim", "Fim"), b("em_aberto", "Sem data de retorno"), t("observacao", "Observação")],
  },
  {
    view: "v_tarefas", titulo: "Tarefas", modulo: "Tarefas", escopo: "usuario", colunasUsuario: ["responsavel_id", "criado_por_id"], colunaData: "prazo", permissoes: ["tasks.view"], tela: "Tarefas",
    descricao: "Tarefas (sem as excluídas): responsável, quem criou, prazo, urgência e situação. Quem não é ADMIN só vê as tarefas em que é responsável ou criador.",
    padrao: ["titulo", "responsavel", "criado_por", "urgencia", "prazo", "situacao", "atrasada"],
    dica: "Pendentes: aberta = sim (periodo 'todo').",
    colunas: [n("tarefa_id", "Id"), t("titulo", "Título"), t("descricao", "Descrição"), n("responsavel_id", "Id do responsável"), t("responsavel", "Responsável"), n("criado_por_id", "Id de quem criou"), t("criado_por", "Quem criou"),
      t("urgencia", "Urgência", ["Baixa", "Média", "Alta", "Urgente"]), d("prazo", "Prazo"),
      t("situacao", "Situação", ["Pendente", "Visualizada", "Em andamento", "Aguardando aprovação da conclusão", "Aguardando autorização para não realizar", "Concluída", "Não realizada", "Cancelada"]),
      b("aberta", "Ainda aberta"), b("atrasada", "Aberta e com prazo vencido"), d("criada_em", "Criada em"), d("concluida_em", "Concluída em"), n("tarefa_principal_id", "Id da tarefa principal (subtarefa)")],
  },
  {
    view: "v_controle_diario", titulo: "Controle diário dos equipamentos", modulo: "Controle Diário", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["daily.view_all"], tela: "Controle Diário",
    descricao: "Registro diário de cada equipamento: operador, se trabalhou, leituras, horas/km trabalhados, abastecimentos, viagens, toras e problemas — lançados no app ou importados de planilha (ex.: Controle Diário de setembro/2026). Registros \"Conferir\" têm leitura duvidosa e ficam sem horas/km trabalhados. Diesel informado no diário NÃO é saída de combustível.",
    padrao: ["data", "equipamento", "frente", "operador", "local", "trabalhou", "trabalhado", "unidade", "viagens", "volume_porto_m3", "diesel_informado", "conferir", "origem_registro"],
    colunas: [n("registro_id", "Id"), d("data", "Data"), ...equipamento, ...frente, t("operador", "Operador"), b("trabalhou", "Trabalhou no dia"), t("motivo_sem_trabalho", "Motivo de não trabalhar"),
      t("unidade", "Unidade", ["h", "km"]), n("leitura_inicial", "Leitura inicial"), n("leitura_final", "Leitura final"), n("trabalhado", "Horas/km trabalhados"), n("litros_abastecidos", "Litros abastecidos"),
      n("viagens", "Viagens"), n("toras", "Toras"), n("metros", "Metros (porto)"), t("producao", "Tipo de produção", ["Baldeio", "Porto"]), b("teve_producao", "Teve produção"), b("teve_problema", "Inativo ou com problema"),
      t("problema", "Problema"), b("lancado_por_terceiro", "Lançado por outra pessoa"), t("local", "Local"), t("observacao", "Observação"),
      t("origem_registro", "Origem do registro", ["Aplicativo", "Importação de planilha"]), t("lote_importacao", "Lote da importação (ex.: IMPORTACAO_SETEMBRO_2026)"),
      b("conferir", "Marcado para conferir (leitura duvidosa)"), t("motivo_conferir", "Motivo do conferir"), b("operador_cadastrado", "Operador ligado ao cadastro de funcionários de campo"),
      b("sem_operador", "Sem operador"), t("local_original", "Local como veio na planilha"), n("viagens_porto", "Viagens no porto"), n("volume_porto_m3", "Volume no porto (m³)"),
      n("toras_porto", "Toras no porto"), n("viagens_baldeio", "Viagens de baldeio"), n("diesel_informado", "Diesel informado no diário (L) — não é saída de combustível"),
      t("observacao_diesel", "Observação do diesel (ex.: acima de 600 L não lançado)")],
  },
  {
    view: "v_controle_diario_problemas", titulo: "Problemas relatados no Controle Diário", modulo: "Controle Diário", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["daily.view_all"], tela: "Pendências",
    descricao: "Problemas que o operador relatou no Controle Diário (do app ou da importação), abertos ou resolvidos na tela Pendências.",
    padrao: ["data", "equipamento", "frente", "operador", "problema", "situacao", "resolucao"],
    colunas: [n("problema_id", "Id"), d("data", "Data"), ...equipamento, ...frente, t("operador", "Operador"), t("problema", "Problema relatado"), t("situacao", "Situação", ["Aberto", "Resolvido"]),
      d("resolvido_em", "Resolvido em"), t("resolvido_por", "Resolvido por"), t("resolucao", "Como foi resolvido"), t("origem", "Origem", ["Aplicativo", "Importação de planilha"]), n("registro_id", "Id do registro diário")],
  },
  {
    view: "v_diario_x_combustivel", titulo: "Diesel: Controle Diário x Combustível", modulo: "Controle Diário", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["daily.view_all"], tela: "Controle Diário",
    descricao: "Por equipamento e dia: diesel informado no Controle Diário x saídas lançadas no Combustível, e a diferença. Use para achar abastecimento não lançado ou informado errado.",
    padrao: ["data", "equipamento", "frente", "diesel_diario", "diesel_combustivel", "diferenca"],
    colunas: [d("data", "Data"), ...equipamento, ...frente, n("diesel_diario", "Diesel no Controle Diário (L)"), n("diesel_combustivel", "Saídas de combustível (L)"), n("diferenca", "Diferença diário − combustível (L)"),
      n("registros_diario", "Registros no diário"), n("saidas_combustivel", "Saídas de combustível"), b("acima_de_600_nao_lancado", "Diário tinha mais de 600 L (não lançado; usou a saída do dia)")],
  },
  {
    view: "v_checklists", titulo: "Checklists pré-uso", modulo: "Controle Diário", escopo: "frente", colunaData: "data", eventos: true, permissoes: ["daily.view_all", "equipment.view"], tela: "Controle Diário",
    descricao: "Checklists antes de ligar o equipamento: situação, itens com problema e O.S. aberta.", padrao: ["data", "equipamento", "frente", "operador", "situacao", "itens_nao_ok", "itens_com_problema", "ordem_servico"],
    colunas: [n("checklist_id", "Id"), d("data", "Data"), n("equipamento_id", "Id do equipamento"), t("equipamento", "Equipamento"), ...frente, t("operador", "Operador"), t("situacao", "Situação", ["OK", "Pendência", "Bloqueado"]),
      n("itens_nao_ok", "Itens não OK"), t("itens_com_problema", "Itens com problema"), t("ordem_servico", "O.S. aberta pelo checklist"), n("leitura", "Leitura"), t("observacao", "Observação")],
  },
  {
    view: "v_pendencias", titulo: "Pendências de dados", modulo: "Pendências", escopo: "frente", perfis: GESTAO, tela: "Pendências",
    descricao: "Dados que precisam de correção manual: saídas de combustível sem veículo, equipamentos sem leitura/plano/frente, estoque negativo, veículos de terceiro incompletos.",
    padrao: ["tipo", "gravidade", "frente", "data", "referencia", "detalhe", "onde_corrigir"],
    colunas: [t("tipo", "Tipo de pendência"), t("gravidade", "Gravidade", ["Alta", "Média", "Baixa"]), ...frente, d("data", "Data (quando houver)"), t("referencia", "O quê (equipamento, produto, placa...)"),
      t("detalhe", "Detalhe"), t("onde_corrigir", "Tela onde corrigir")],
  },
  {
    view: "v_usuarios", titulo: "Usuários do sistema", modulo: "Usuários", escopo: "admin", perfis: ["ADMIN"], tela: "Usuários",
    descricao: "Usuários com perfil, situação, frentes e último acesso (sem senha nem dados de acesso). Só ADMIN.",
    padrao: ["nome", "usuario", "perfil", "situacao", "frente_principal", "todas_as_frentes", "frentes", "ultimo_acesso"],
    colunas: [n("usuario_id", "Id"), t("nome", "Nome"), t("usuario", "Login"), t("email", "E-mail"), t("perfil", "Perfil"), t("situacao", "Situação", ["Ativo", "Inativo"]), t("frente_principal", "Frente principal"),
      b("todas_as_frentes", "Enxerga todas as frentes"), t("frentes", "Frentes vinculadas"), t("cargo_tarefas", "Cargo no módulo Tarefas"), t("funcao", "Função"), d("ultimo_acesso", "Último acesso")],
  },
];

const BY_VIEW = new Map(CATALOGO.map((item) => [item.view, item]));
export const viewDoCatalogo = (view: string) => BY_VIEW.get(view) ?? null;

export function podeConsultar(item: ViewCatalogo, user: { profile: Profile; permissions: readonly string[] }) {
  if (item.escopo === "admin" && user.profile !== "ADMIN") return false;
  if (item.perfis && !item.perfis.includes(user.profile)) return false;
  if (item.permissoes && !item.permissoes.some((permission) => user.permissions.includes(permission))) return false;
  return true;
}

export function catalogoDoUsuario(user: { profile: Profile; permissions: readonly string[] }) {
  return CATALOGO.filter((item) => podeConsultar(item, user));
}

// Resumo curto (uma linha por view) para o prompt de sistema.
export function resumoCatalogo(user: { profile: Profile; permissions: readonly string[] }) {
  return catalogoDoUsuario(user).map((item) => `- ${item.view}: ${item.titulo} — ${item.descricao}${item.colunaData ? ` [período: ${item.colunaData}]` : " [retrato atual]"}`).join("\n");
}
