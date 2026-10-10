import { setFieldProductionRegister } from "../../../../lib/production";
import { productionRoute, readBody } from "../../../../lib/production-api";

// Liga/desliga o "Apontador da Produção" de um funcionário de campo ({ userId, value }).
export async function PUT(request: Request) {
  return productionRoute(request, "apontadores", async ({ db, user }) => {
    const body = await readBody(request);
    const value = body.value === true;
    const name = await setFieldProductionRegister(db, user, Number(body.userId), value);
    return Response.json({ message: value ? `${name} agora lança a Produção pelo celular.` : `${name} não lança mais a Produção.` });
  }, { write: true });
}
