import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { sendTest } from "../../../../lib/notifications";

// "Enviar teste": manda um aviso para todos os aparelhos ativos da própria pessoa e diz o resultado.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const result = await sendTest(auth.user!);
    const message = !result.devices ? "Nenhum aparelho ativado. Toque em \"Ativar notificações neste aparelho\" primeiro."
      : result.failed ? `Enviado para ${result.sent} de ${result.devices} aparelho(s). ${result.failed} falhou(aram) — veja em Meus aparelhos.`
        : `Teste enviado para ${result.sent} aparelho(s). Deve chegar em alguns segundos.`;
    return Response.json({ ...result, message });
  } catch (error) {
    console.error("[notifications.test]", error);
    return Response.json({ error: "Não foi possível enviar o teste." }, { status: 500 });
  }
}
