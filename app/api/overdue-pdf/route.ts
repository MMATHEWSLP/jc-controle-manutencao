import { GET as getAlertsReport } from "../alerts-report-pdf/route";

export async function GET(request:Request){
  const url=new URL(request.url);url.pathname="/api/alerts-report-pdf";url.searchParams.delete("status");url.searchParams.append("status","OVERDUE");
  url.searchParams.append("status","NEAR");
  const response=await getAlertsReport(new Request(url.toString(),request));
  if(!response.ok)return response;
  const headers=new Headers(response.headers);headers.set("Content-Disposition",`attachment; filename="manutencoes-vencidas-${new Date().toISOString().slice(0,10)}.pdf"`);
  return new Response(response.body,{status:response.status,headers});
}
