// Id gerado no navegador (crypto.randomUUID) a cada envio de formulário. O servidor grava junto
// com o registro (coluna client_request_id, única): se o mesmo envio chegar de novo — fila
// offline reenviando ou resposta que se perdeu no sinal fraco — ele é reconhecido e não duplica.
export function readClientRequestId(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}

export function isUniqueViolation(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}
