import { clearSessionCookie, ensurePrimaryAdmin, publicUser, readSession, sessionCookie } from "../../../../lib/auth";

// Checagem da sessão (o app chama ao abrir, ao voltar para a tela e antes de enviar a fila offline).
//  - sessão válida: devolve o usuário e reenvia o cookie (persistente), que assim nunca vence com uso;
//  - sessão que não vale mais: { user: null } e apaga o cookie — é a ÚNICA resposta que leva o app
//    para a tela de login;
//  - falha do servidor/banco: 503. O app entende como "sem confirmação agora" e continua logado.
export async function GET(request: Request) {
  try {
    await ensurePrimaryAdmin();
    const session = await readSession(request);
    const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
    if (session.token) headers["Set-Cookie"] = session.user ? sessionCookie(session.token) : clearSessionCookie();
    return Response.json({ user: session.user ? publicUser(session.user) : null }, { headers });
  } catch (error) {
    console.error("[auth.session] Falha interna ao validar sessão", error);
    return Response.json({ error: "Não foi possível validar a sessão agora." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
