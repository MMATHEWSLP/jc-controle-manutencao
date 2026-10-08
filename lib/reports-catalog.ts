// ---------------------------------------------------------------------------
// Menu RELATÓRIOS: catálogo de todos os relatórios do sistema, por categoria, com busca.
// Puro (sem banco): a tela usa para montar os cartões e as rotas usam para autorizar.
//
// Quem vê cada relatório:
//  - ADMIN vê tudo; GESTOR nasce com as permissões "reports.*" (pedido explícito do administrador:
//    "ADMIN e GESTOR veem tudo"), que podem ser tiradas por usuário em Usuários → Permissões;
//  - os demais perfis só veem as categorias liberadas por usuário (reports.<categoria>) e só das
//    frentes deles (cada rota filtra pelas frentes de lib/access.ts);
//  - quem já abria um relatório no lugar antigo continua abrindo (legacy: a permissão do módulo de
//    onde ele saiu), para a mudança de menu não tirar acesso de ninguém.
// ---------------------------------------------------------------------------
import type { Permission } from "./auth";

export const REPORT_CATEGORIES = [
  { key: "producao", label: "Produção", permission: "reports.producao", description: "Controle Diário: horas e KM trabalhados, viagens, volume no porto, toras e baldeio." },
  { key: "combustivel", label: "Combustível", permission: "reports.combustivel", description: "Entradas, saídas e saldos, terceiros/doações, prestadores, comboio e a conferência com o Controle Diário." },
  { key: "pecas", label: "Peças e produtos", permission: "reports.pecas", description: "Saídas por produto, equipamento, colaborador, departamento e terceiro; produtos com saldo." },
  { key: "manutencao", label: "Manutenção", permission: "reports.manutencao", description: "Trocas de óleo, trocas vencidas e o status da frota." },
  { key: "custos", label: "Custos", permission: "reports.custos", description: "Combustível, peças e trocas por equipamento e o custo total." },
  { key: "resumos", label: "Resumos", permission: "reports.resumos", description: "Resumo da operação da semana." },
] as const;

export type ReportCategory = typeof REPORT_CATEGORIES[number]["key"];
export type ReportPermission = typeof REPORT_CATEGORIES[number]["permission"];

export type ReportId =
  | "producao" | "combustivel-movimentacao" | "combustivel-dia" | "diario-combustivel" | "consumo-terceiros" | "terceiros-empresa" | "comboio"
  | "estoque-saidas" | "produtos-estoque" | "trocas-oleo" | "trocas-vencidas" | "frota-diario" | "custos-consumo" | "resumo-semanal";

export type ReportDef = {
  id: ReportId;
  category: ReportCategory;
  title: string;
  description: string;
  // Palavras extras para a busca (sinônimos, nomes antigos).
  keywords: string;
  formats: string;
  // Permissões do módulo onde o relatório ficava antes (continuam dando acesso a ele).
  legacy?: readonly Permission[];
  // Onde mais o relatório aparece (fica nos dois lugares).
  alsoIn?: string;
};

const DAILY_VIEW: readonly Permission[] = ["daily.view_all", "daily.manage"];
const THIRD_PARTY_VIEW: readonly Permission[] = ["third_parties.manage", "fuel.view", "fuel.register", "stock.exits_view", "stock.exits_create"];

export const REPORTS: readonly ReportDef[] = [
  {
    id: "producao", category: "producao", title: "Produção do Controle Diário",
    description: "Horas e KM trabalhados, viagens, volume e toras no porto, baldeio e diesel informado, por frente, local, operador ou equipamento.",
    keywords: "controle diario horas km viagens porto volume m3 toras baldeio operador local equipamento", formats: "Excel · PDF", legacy: DAILY_VIEW,
  },
  {
    id: "combustivel-movimentacao", category: "combustivel", title: "Entradas, saídas e saldos",
    description: "Movimentação de diesel e gasolina no período (entradas, saídas, transferências) com o saldo, por frente, combustível e estoque.",
    keywords: "combustivel diesel gasolina entrada saida transferencia saldo historico movimentacao estoque frente porto", formats: "Excel · PDF", legacy: ["fuel.view"],
    alsoIn: "Combustível → Histórico",
  },
  {
    id: "combustivel-dia", category: "combustivel", title: "Resumo do dia do combustível",
    description: "Um dia de uma frente: saldo, entradas, saídas com o valor, transferências e o texto para o WhatsApp.",
    keywords: "resumo diario dia whatsapp diesel saidas valor transferencias", formats: "PDF · texto", legacy: ["fuel.view"],
    alsoIn: "Combustível → Histórico → Resumo do dia",
  },
  {
    id: "diario-combustivel", category: "combustivel", title: "Conferência Diário x Combustível",
    description: "Diesel informado pelo operador no Controle Diário x saídas lançadas no Combustível, por equipamento e dia.",
    keywords: "conferencia diario combustivel diesel informado operador diferenca", formats: "Excel · PDF", legacy: DAILY_VIEW,
  },
  {
    id: "consumo-terceiros", category: "combustivel", title: "Consumo de terceiros",
    description: "Terceiros/doações e prestadores: litros, leituras e consumo (km/L ou L/h) de cada veículo, com os fora da média.",
    keywords: "terceiros doacoes prestadores consumo km/l l/h veiculo placa empresa", formats: "Excel", legacy: ["fuel.view"],
    alsoIn: "Combustível → Consumo de Terceiros",
  },
  {
    id: "terceiros-empresa", category: "combustivel", title: "Terceiros: resumo por empresa",
    description: "Combustível e peças que cada terceiro recebeu, nos veículos dele e para os funcionários, com o valor total.",
    keywords: "terceiros doacoes prestadores empresa resumo pecas combustivel valor funcionarios veiculos", formats: "Excel", legacy: THIRD_PARTY_VIEW,
  },
  {
    id: "comboio", category: "combustivel", title: "Abastecimentos do comboio",
    description: "Por período, comboio, motorista e equipamento: litros aprovados e pendentes, rejeitados, sem foto e tempo até aprovar.",
    keywords: "comboio abastecimentos motorista aprovacao aprovados pendentes rejeitados foto", formats: "Tela", legacy: ["fuel.convoy_approve", "fuel.view"],
  },
  {
    id: "estoque-saidas", category: "pecas", title: "Saídas de produtos",
    description: "Peças e produtos que saíram do estoque, por produto, equipamento, colaborador, departamento ou terceiro, com o valor.",
    keywords: "pecas produtos estoque saidas movimentacao equipamento colaborador funcionario departamento terceiro sai os valor", formats: "Excel", legacy: ["stock.exits_view"],
    alsoIn: "Produtos → Movimentação → Histórico",
  },
  {
    id: "produtos-estoque", category: "pecas", title: "Produtos e saldo em estoque",
    description: "Lista de produtos com TAG, referência, fornecedor, preço e o saldo nas frentes em exibição.",
    keywords: "produtos lista catalogo estoque saldo tag referencia fornecedor preco", formats: "PDF · CSV", legacy: ["products.view"],
    alsoIn: "Produtos",
  },
  {
    id: "trocas-oleo", category: "manutencao", title: "Trocas de óleo realizadas",
    description: "Histórico das trocas por período, frente, equipamento, categoria e responsável.",
    keywords: "trocas oleo manutencao historico realizadas filtro responsavel os", formats: "Excel · PDF", legacy: ["maintenance.history"],
    alsoIn: "Troca de Óleo → Histórico",
  },
  {
    id: "trocas-vencidas", category: "manutencao", title: "Trocas vencidas e alertas",
    description: "Situação atual dos planos de troca: vencidas, urgentes e perto de vencer, por categoria e frente.",
    keywords: "trocas vencidas alertas urgentes perto de vencer central de alertas planos", formats: "PDF", legacy: ["alerts.view"],
    alsoIn: "Troca de Óleo → Central de alertas",
  },
  {
    id: "frota-diario", category: "manutencao", title: "Status da frota do dia",
    description: "Movimentações do dia na frota: operando, parados, em manutenção e aguardando peça.",
    keywords: "status frota parados manutencao aguardando peca relatorio diario", formats: "PDF", legacy: ["fleet.report"],
    alsoIn: "Status da Frota",
  },
  {
    id: "custos-consumo", category: "custos", title: "Custos e consumo por equipamento",
    description: "Combustível (litros e R$), consumo comparado à média do tipo, peças e trocas por equipamento, com o custo total e o custo por hora/km.",
    keywords: "custos consumo equipamento combustivel pecas trocas total custo por hora km media", formats: "CSV",
  },
  {
    id: "resumo-semanal", category: "resumos", title: "Resumo semanal",
    description: "A semana (segunda a domingo): combustível, custos, manutenção, O.S., checklists e Controle Diário, com o texto do WhatsApp.",
    keywords: "resumo semanal semana whatsapp gestao", formats: "Texto · impressão",
  },
];

type UserLike = { profile: string; permissions: readonly string[] };

export function reportById(id: string) {
  return REPORTS.find((report) => report.id === id) ?? null;
}

export function categoryOf(key: ReportCategory) {
  return REPORT_CATEGORIES.find((category) => category.key === key)!;
}

// Permissões que dão acesso ao relatório (a da categoria + as do lugar antigo). As rotas usam em
// authorize(request, reportGrants(...)).
export function reportGrants(id: ReportId): Permission[] {
  const report = reportById(id);
  if (!report) return [];
  return [categoryOf(report.category).permission, ...(report.legacy ?? [])];
}

export function canSeeReport(user: UserLike | null | undefined, id: ReportId) {
  if (!user || user.profile === "CAMPO") return false;
  if (user.profile === "ADMIN") return true;
  return reportGrants(id).some((permission) => user.permissions.includes(permission));
}

export function visibleReports(user: UserLike | null | undefined) {
  return REPORTS.filter((report) => canSeeReport(user, report.id));
}

const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR");

// Busca sem acento: todas as palavras digitadas precisam aparecer no título, descrição, categoria ou palavras-chave.
export function searchReports(reports: readonly ReportDef[], query: string) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...reports];
  return reports.filter((report) => {
    const haystack = normalize(`${report.title} ${report.description} ${categoryOf(report.category).label} ${report.keywords} ${report.alsoIn ?? ""}`);
    return words.every((word) => haystack.includes(word));
  });
}

// Cartões agrupados na ordem das categorias (categorias sem relatório visível ficam de fora).
export function groupReports(reports: readonly ReportDef[]) {
  return REPORT_CATEGORIES.map((category) => ({ category, reports: reports.filter((report) => report.category === category.key) })).filter((group) => group.reports.length > 0);
}
