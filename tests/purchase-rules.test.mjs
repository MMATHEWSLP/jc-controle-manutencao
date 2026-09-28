import assert from "node:assert/strict";
import test from "node:test";
import { brandName, catalogKey } from "../lib/catalog-rules.ts";
import { availableActions, canDo, matchesSituation, orderStatusFromItems, quantityProblem } from "../lib/purchase-rules.ts";
import { detectAttachment, detectDocument, opensInline } from "../lib/quote-files.ts";

const items = (...statuses) => statuses.map((status) => ({ status }));
const caps = (overrides = {}) => ({ approve: false, buy: false, pay: false, dispatch: false, manage: false, own: false, ...overrides });

test("situação geral do pedido combina os itens", () => {
  assert.equal(orderStatusFromItems(items("AGUARDANDO_APROVACAO", "AGUARDANDO_APROVACAO")), "AGUARDANDO_APROVACAO");
  assert.equal(orderStatusFromItems(items("EM_COTACAO", "AGUARDANDO_APROVACAO")), "EM_ANDAMENTO");
  // Item recusado/removido não segura o pedido: vale a etapa dos que seguem.
  assert.equal(orderStatusFromItems(items("PAGO", "RECUSADO", "REMOVIDO")), "PAGO");
  // Só fica Recebido quando todos os que seguem chegaram.
  assert.equal(orderStatusFromItems(items("RECEBIDO", "ENVIADO")), "EM_ANDAMENTO");
  assert.equal(orderStatusFromItems(items("RECEBIDO", "RECEBIDO", "REMOVIDO")), "RECEBIDO");
  assert.equal(orderStatusFromItems(items("RECUSADO", "RECUSADO")), "RECUSADO");
  assert.equal(orderStatusFromItems(items("RECUSADO", "REMOVIDO")), "RECUSADO");
  assert.equal(orderStatusFromItems(items("REMOVIDO")), "CANCELADO");
  assert.equal(orderStatusFromItems(items("EM_COTACAO"), true), "CANCELADO");
});

test("filtros de situação (pagos, parcialmente pagos, sem orçamento, em análise, urgentes)", () => {
  const order = (statuses, extra = {}) => ({ urgency: "NORMAL", quoteCount: 0, items: items(...statuses), ...extra });
  assert.equal(matchesSituation(order(["PAGO", "ENVIADO", "REMOVIDO"]), "PAGOS"), true);
  assert.equal(matchesSituation(order(["PAGO", "ANALISE_PAGAMENTO"]), "PAGOS"), false);
  assert.equal(matchesSituation(order(["PAGO", "ANALISE_PAGAMENTO"]), "PARCIALMENTE_PAGOS"), true);
  assert.equal(matchesSituation(order(["RECEBIDO", "RECEBIDO"]), "PARCIALMENTE_PAGOS"), false);
  assert.equal(matchesSituation(order(["EM_COTACAO"]), "SEM_ORCAMENTO"), true);
  assert.equal(matchesSituation(order(["EM_COTACAO"], { quoteCount: 2 }), "SEM_ORCAMENTO"), false);
  assert.equal(matchesSituation(order(["AGUARDANDO_APROVACAO"]), "SEM_ORCAMENTO"), false, "ainda não aprovado");
  assert.equal(matchesSituation(order(["AGUARDANDO_APROVACAO", "PAGO"]), "EM_ANALISE"), true);
  assert.equal(matchesSituation(order(["ANALISE_PAGAMENTO"]), "EM_ANALISE"), true);
  assert.equal(matchesSituation(order(["EM_COTACAO"]), "EM_ANALISE"), false);
  assert.equal(matchesSituation(order(["EM_COTACAO"], { urgency: "URGENTE" }), "URGENTES"), true);
  assert.equal(matchesSituation(order(["EM_COTACAO"], { urgency: "ALTA" }), "URGENTES"), false);
});

test("ações por item seguem a etapa de cada item e a função da pessoa", () => {
  const mixed = items("AGUARDANDO_APROVACAO", "EM_COTACAO", "ENVIADO");
  const approver = availableActions(mixed, caps({ approve: true }));
  assert.equal(approver.APPROVE, true);
  assert.equal(approver.QUOTE, false);
  const buyer = availableActions(mixed, caps({ buy: true }));
  assert.equal(buyer.QUOTE && buyer.REMOVE && buyer.SEND_TO_PAYMENT, true);
  assert.equal(buyer.APPROVE, false);
  assert.equal(availableActions(mixed, caps({ own: true })).RECEIVE, true);
  // Quem só é da frente (sem função) só consulta.
  const viewer = availableActions(mixed, caps());
  assert.equal(Object.values(viewer).some(Boolean), false);
  assert.equal(availableActions(mixed, caps({ approve: true }), true).APPROVE, false, "pedido cancelado");
  assert.equal(canDo("CONFIRM_PAYMENT", caps({ pay: true })), true);
  assert.equal(canDo("DISPATCH", caps({ pay: true })), false);
});

test("cancelamento: quem pediu só antes da aprovação; gestão até antes do pagamento", () => {
  assert.equal(availableActions(items("AGUARDANDO_APROVACAO"), caps({ own: true })).CANCEL, true);
  assert.equal(availableActions(items("AGUARDANDO_APROVACAO", "EM_COTACAO"), caps({ own: true })).CANCEL, false);
  assert.equal(availableActions(items("EM_COTACAO", "ANALISE_PAGAMENTO"), caps({ manage: true })).CANCEL, true);
  assert.equal(availableActions(items("EM_COTACAO", "PAGO"), caps({ manage: true })).CANCEL, false);
});

test("comprador só reduz a quantidade na cotação", () => {
  assert.equal(quantityProblem(10, 6), null);
  assert.equal(quantityProblem(10, 10), null);
  assert.match(quantityProblem(10, 12), /só pode ser reduzida/);
  assert.match(quantityProblem(10, 0), /maior que zero/);
  assert.match(quantityProblem(10, NaN), /maior que zero/);
});

test("fornecedor/marca: mesma chave para grafias diferentes", () => {
  assert.equal(catalogKey("Randon"), catalogKey("RANDON"));
  assert.equal(catalogKey("Ran-don "), "RANDON");
  assert.equal(catalogKey("São Paulo Peças"), "SAOPAULOPECAS");
  assert.equal(brandName("  randon   implementos "), "RANDON IMPLEMENTOS");
});

test("anexos: imagem para foto/orçamento por imagem; PDF/Word/Excel para orçamento por documento", () => {
  const pdf = Buffer.from("%PDF-1.7\n...");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const zip = (names) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(names.join("\0"), "latin1")]);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.equal(detectDocument(pdf, "orcamento.pdf").extension, "pdf");
  assert.equal(detectDocument(zip(["[Content_Types].xml", "word/document.xml"]), "a.docx").extension, "docx");
  assert.equal(detectDocument(zip(["[Content_Types].xml", "xl/workbook.xml"]), "a.xlsx").extension, "xlsx");
  assert.equal(detectDocument(zip(["mimetypeapplication/vnd.oasis.opendocument.spreadsheet"]), "a.ods").extension, "ods");
  assert.equal(detectDocument(zip(["qualquer/coisa.txt"]), "a.zip"), null, "zip comum não é documento");
  assert.equal(detectDocument(ole, "planilha.xls").contentType, "application/vnd.ms-excel");
  assert.equal(detectDocument(ole, "arquivo.exe"), null);
  assert.equal(detectDocument(Buffer.from("item;qtd\nfiltro;2\n"), "cotacao.csv").extension, "csv");
  assert.equal(detectDocument(Buffer.from([0x4d, 0x5a, 0, 1]), "virus.csv"), null, "binário com extensão de texto");
  assert.equal(detectAttachment("QUOTE_IMAGE", png, "print.png").extension, "png");
  assert.equal(detectAttachment("QUOTE_IMAGE", pdf, "orcamento.pdf"), null, "PDF vai em orçamento por documento");
  assert.equal(detectAttachment("PHOTO", pdf, "foto.pdf"), null);
  assert.equal(detectAttachment("QUOTE_DOCUMENT", png, "print.png"), null, "imagem vai em orçamento por imagem");
  assert.equal(opensInline("application/pdf"), true);
  assert.equal(opensInline("application/vnd.ms-excel"), false);
});
