// Chave de comparação de fornecedores e marcas: sem acentos, espaços e pontuação, em maiúsculas —
// "Randon", "RANDON" e "Ran-don" são a mesma marca. Usada no banco (product_brands.key) e na tela.
export function catalogKey(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// Nome exibido/gravado da marca: maiúsculas, espaços simples.
export function brandName(value: string) {
  return value.trim().replace(/\s+/g, " ").toUpperCase().slice(0, 80);
}

// Nome gravado do departamento: mesma regra da marca (maiúsculas, espaços simples).
export const departmentName = (value: string) => brandName(value);
