import { authorize } from "../../../../../lib/auth";
import { exigeAdmin, modeloPlanilha } from "../../../../../lib/daily-import";

export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  try { exigeAdmin(auth.user!); } catch { return Response.json({ error: "Só ADMIN." }, { status: 403 }); }
  return new Response(new Uint8Array(await modeloPlanilha()), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="modelo-controle-diario.xlsx"' } });
}
