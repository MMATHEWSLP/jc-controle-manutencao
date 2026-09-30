// Aviso curto quando um carregamento de dados falha (em vez de a lista simplesmente ficar vazia).
export default function LoadWarning({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <div className="operation-error compact" role="alert"><span>!</span><div><strong>Atenção</strong><p>{message}</p></div></div>;
}
