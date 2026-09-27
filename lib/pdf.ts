type PdfSection={label:string;value:string};
type MaintenancePdfInput={title:string;equipment:string;category:string;brand:string;model:string;date:string;reading:string;services:string[];notes:string;responsible:string;workOrder:string;generatedAt:string};
export type OverdueMaintenancePdfItem={prefix:string;equipment:string;front:string;maintenance:string;currentValue:number;nextValue:number;overdueValue:number;unit:"HOURS"|"KM"};
type OverdueMaintenancesPdfInput={items:OverdueMaintenancePdfItem[];generatedAt:string};
export type ReportStatus="OK"|"WARNING"|"NEAR"|"OVERDUE";
export type CategorizedReportItem={
  category:string;equipmentKey:string;prefix:string;equipment:string;front:string;date:string;primary:string;secondary:string;
  status:ReportStatus|null;unit:"HOURS"|"KM";currentValue:number|null;lastValue?:number|null;plannedValue:number|null;differenceValue:number|null;responsible:string;
};
export type CategorizedMaintenanceReportInput={
  title:string;kind:"ALERTS"|"HISTORY";items:CategorizedReportItem[];generatedAt:string;
  filters:{period:string;status:string;categories:string;other:string};
};

const ptFormatter=new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"});
const cp1252:Record<number,number>={0x2013:150,0x2014:151,0x2018:145,0x2019:146,0x201c:147,0x201d:148,0x2022:149,0x2026:133};

function encodeBinary(value:string){
  const bytes:number[]=[];
  for(const character of value){const code=character.codePointAt(0)??63;bytes.push(code<=255?code:cp1252[code]??63);}
  return Uint8Array.from(bytes);
}
function escapePdf(value:string){return value.replaceAll("\\","\\\\").replaceAll("(","\\(").replaceAll(")","\\)");}
function wrap(value:string,max=88){
  const words=value.replace(/\s+/g," ").trim().split(" ");const lines:string[]=[];let line="";
  for(const word of words){const next=line?`${line} ${word}`:word;if(next.length>max&&line){lines.push(line);line=word;}else line=next;}
  if(line)lines.push(line);return lines.length?lines:["—"];
}
function text(x:number,y:number,size:number,value:string,bold=false,color="0.12 0.20 0.27"){
  return `${color} rg BT /${bold?"F2":"F1"} ${size} Tf ${x} ${y} Td (${escapePdf(value)}) Tj ET\n`;
}
function fromBase64(value:string){const binary=atob(value);return Uint8Array.from(binary,(character)=>character.charCodeAt(0));}
function binaryString(value:Uint8Array){let output="";for(const byte of value)output+=String.fromCharCode(byte);return output;}
function logo(x:number,y:number,width:number){const height=width*(PDF_LOGO_HEIGHT/PDF_LOGO_WIDTH);return `q ${width} 0 0 ${height.toFixed(2)} ${x} ${y} cm /Logo Do Q\n`;}

function buildPdf(rawPages:string[],pageSize={width:595,height:842}){
  const pages=rawPages.length?rawPages:[""];
  const regularFontId=3+(pages.length*2);const boldFontId=regularFontId+1;const logoId=boldFontId+1;
  const kids=pages.map((_,index)=>`${3+(index*2)} 0 R`).join(" ");
  const objects:string[]=["<< /Type /Catalog /Pages 2 0 R >>",`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`];
  pages.forEach((content,index)=>{
    const pageId=3+(index*2);const contentId=pageId+1;const contentBytes=encodeBinary(content);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageSize.width} ${pageSize.height}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> /XObject << /Logo ${logoId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`);
  });
  const logoBytes=fromBase64(PDF_LOGO_JPEG_BASE64);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",`<< /Type /XObject /Subtype /Image /Width ${PDF_LOGO_WIDTH} /Height ${PDF_LOGO_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoBytes.length} >>\nstream\n${binaryString(logoBytes)}\nendstream`);
  const chunks:Uint8Array[]=[encodeBinary("%PDF-1.4\n%âãÏÓ\n")];const offsets=[0];let offset=chunks[0].length;
  objects.forEach((object,index)=>{offsets.push(offset);const chunk=encodeBinary(`${index+1} 0 obj\n${object}\nendobj\n`);chunks.push(chunk);offset+=chunk.length;});
  const xrefOffset=offset;let xref=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(const item of offsets.slice(1))xref+=`${String(item).padStart(10,"0")} 00000 n \n`;xref+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(encodeBinary(xref));const total=chunks.reduce((sum,chunk)=>sum+chunk.length,0);const output=new Uint8Array(total);let cursor=0;for(const chunk of chunks){output.set(chunk,cursor);cursor+=chunk.length;}return output;
}

function truncate(value:string,max:number){const normalized=value.replace(/\s+/g," ").trim()||"—";return normalized.length<=max?normalized:`${normalized.slice(0,Math.max(1,max-1))}…`;}
const overdueNumberFormat=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1});
function overdueReading(value:number,unit:"HOURS"|"KM"){return `${overdueNumberFormat.format(value)} ${unit==="KM"?"km":"h"}`;}

export function createOverdueMaintenancesPdf(input:OverdueMaintenancesPdfInput){
  const perPage=18;const pageCount=Math.max(1,Math.ceil(input.items.length/perPage));const equipmentCount=new Set(input.items.map((item)=>item.prefix)).size;
  const pages=Array.from({length:pageCount},(_,pageIndex)=>{
    const items=input.items.slice(pageIndex*perPage,(pageIndex+1)*perPage);let content="";
    content+="1 1 1 rg 0 752 595 90 re f\n";content+="0.16 0.48 0.66 rg 0 746 595 6 re f\n";content+=logo(36,774,88);
    content+=text(136,810,9,"MANUTENÇÃO PREVENTIVA",true,"0.08 0.49 0.35");content+=text(136,787,16,"MANUTENÇÕES VENCIDAS",true,"0.08 0.25 0.36");content+=text(136,770,8,"RELATÓRIO CONSOLIDADO DA FROTA",false,"0.31 0.46 0.55");
    content+=text(430,810,8,"GERADO EM",true,"0.31 0.46 0.55");content+=text(430,793,9,input.generatedAt,false,"0.08 0.25 0.36");
    content+="0.96 0.97 0.98 rg 36 704 523 28 re f\n";
    content+=text(46,715,8,`TOTAL: ${input.items.length}`,true,"0.15 0.27 0.36");content+=text(160,715,8,`EQUIPAMENTOS: ${equipmentCount}`,true,"0.15 0.27 0.36");content+=text(444,715,8,`PÁGINA ${pageIndex+1}/${pageCount}`,true,"0.15 0.27 0.36");
    content+="0.11 0.35 0.49 rg 36 666 523 25 re f\n";
    content+=text(43,675,7,"EQUIP.",true,"1 1 1");content+=text(108,675,7,"MODELO / FRENTE",true,"1 1 1");content+=text(226,675,7,"MANUTENÇÃO",true,"1 1 1");content+=text(400,675,7,"ATUAL",true,"1 1 1");content+=text(457,675,7,"PRÓXIMA",true,"1 1 1");content+=text(514,675,7,"VENCIDA",true,"1 1 1");
    if(items.length===0){content+=text(175,615,12,"Nenhuma manutenção vencida no momento.",true,"0.18 0.45 0.35");}
    items.forEach((item,index)=>{
      const top=641-(index*31);if(index%2===0)content+=`0.965 0.975 0.98 rg 36 ${top-16} 523 30 re f\n`;
      content+=text(43,top,8,truncate(item.prefix,11),true);
      content+=text(108,top+2,7,truncate(item.equipment,25),true);content+=text(108,top-10,6,truncate(`Frente ${item.front}`,28),false,"0.39 0.49 0.56");
      content+=text(226,top,7,truncate(item.maintenance,34),true);
      content+=text(400,top,7,overdueReading(item.currentValue,item.unit),false);
      content+=text(457,top,7,overdueReading(item.nextValue,item.unit),false);
      content+=text(514,top,7,overdueReading(item.overdueValue,item.unit),true,"0.73 0.13 0.18");
      content+=`0.88 0.91 0.93 RG 0.35 w 36 ${top-16} m 559 ${top-16} l S\n`;
    });
    content+="0.86 0.90 0.92 RG 0.6 w 36 55 m 559 55 l S\n";content+=text(42,36,8,"Relatório gerado com os dados atuais da Central de Alertas. Nenhum registro foi alterado.",false,"0.42 0.51 0.58");
    return content;
  });
  return buildPdf(pages);
}

const reportStatusLabels:Record<ReportStatus,string>={OK:"NORMAL",WARNING:"ATENÇÃO",NEAR:"URGENTE",OVERDUE:"VENCIDO"};
function reportStatus(item:CategorizedReportItem){return item.status?reportStatusLabels[item.status]:"—";}
function reportValue(value:number|null,unit:"HOURS"|"KM"){
  return value===null||!Number.isFinite(value)?"—":`${overdueNumberFormat.format(value)} ${unit==="KM"?"km":"h"}`;
}
function reportSummary(items:CategorizedReportItem[]){
  const count=(status:ReportStatus)=>items.filter((item)=>item.status===status).length;
  return {equipment:new Set(items.map((item)=>item.equipmentKey)).size,records:items.length,normal:count("OK"),warning:count("WARNING"),near:count("NEAR"),overdue:count("OVERDUE")};
}

function createAlertsMaintenanceReportPdf(input:CategorizedMaintenanceReportInput){
  const rowsPerPage=8;
  const normalized=input.items.map((item)=>({...item,category:item.category.trim()||"Sem categoria cadastrada"}));
  const categories=[...new Set(normalized.map((item)=>item.category))].sort((a,b)=>a.localeCompare(b,"pt-BR",{sensitivity:"base"}));
  const pageDefinitions:Array<{category:string;items:CategorizedReportItem[];categoryPage:number;categoryPages:number;summary:ReturnType<typeof reportSummary>}>=[];
  if(categories.length===0)pageDefinitions.push({category:"SEM REGISTROS",items:[],categoryPage:1,categoryPages:1,summary:reportSummary([])});
  for(const category of categories){
    const categoryItems=normalized.filter((item)=>item.category===category);const categoryPages=Math.max(1,Math.ceil(categoryItems.length/rowsPerPage));const summary=reportSummary(categoryItems);
    for(let page=0;page<categoryPages;page++)pageDefinitions.push({category,items:categoryItems.slice(page*rowsPerPage,(page+1)*rowsPerPage),categoryPage:page+1,categoryPages,summary});
  }
  const totalSummary=reportSummary(normalized);
  const pages=pageDefinitions.map((definition,pageIndex)=>{
    let content="";
    content+="1 1 1 rg 0 514 842 81 re f\n";content+="0.16 0.48 0.66 rg 0 514 842 5 re f\n";
    content+=logo(28,531,88);
    content+=text(130,570,8,"MANUTENÇÃO PREVENTIVA",true,"0.08 0.49 0.35");content+=text(130,548,16,truncate(input.title.toUpperCase(),58),true,"0.08 0.25 0.36");content+=text(130,531,7.5,"CENTRAL DE ALERTAS · ORGANIZADO POR CATEGORIA",false,"0.31 0.46 0.55");
    content+=text(674,570,7,"GERADO EM",true,"0.31 0.46 0.55");content+=text(674,553,8,truncate(input.generatedAt,24),false,"0.08 0.25 0.36");content+=text(674,536,7,`PÁGINA ${pageIndex+1}/${pageDefinitions.length}`,true,"0.16 0.48 0.66");
    const cards=[
      {x:28,width:188,label:"PERÍODO",value:input.filters.period},
      {x:222,width:188,label:"STATUS",value:input.filters.status},
      {x:416,width:188,label:"CATEGORIAS",value:input.filters.categories},
      {x:610,width:204,label:"OUTROS FILTROS",value:input.filters.other},
    ];
    for(const card of cards){content+=`0.96 0.975 0.98 rg ${card.x} 455 ${card.width} 48 re f\n`;content+=text(card.x+10,487,6.5,card.label,true,"0.34 0.47 0.56");content+=text(card.x+10,469,8,truncate(card.value,Math.floor(card.width/4.7)),true,"0.11 0.24 0.32");}
    const categoryTitle=definition.categoryPage>1?`${definition.category.toUpperCase()} · CONTINUAÇÃO`:definition.category.toUpperCase();
    content+=text(28,429,7,"CATEGORIA",true,"0.00 0.52 0.37");content+=text(28,411,13,truncate(categoryTitle,82),true,"0.04 0.22 0.33");
    content+=text(676,421,8,`TOTAL GERAL: ${totalSummary.records} REGISTROS`,true,"0.04 0.22 0.33");
    content+="0.91 0.97 0.95 rg 28 363 786 34 re f\n";
    const summary=definition.summary;
    content+=text(39,381,7,`EQUIPAMENTOS  ${summary.equipment}`,true,"0.08 0.38 0.29");content+=text(157,381,7,`REGISTROS  ${summary.records}`,true,"0.08 0.38 0.29");content+=text(260,381,7,`NORMAIS  ${summary.normal}`,true,"0.08 0.38 0.29");content+=text(354,381,7,`ATENÇÃO  ${summary.warning}`,true,"0.64 0.40 0.05");content+=text(459,381,7,`URGENTES  ${summary.near}`,true,"0.88 0.31 0.04");content+=text(566,381,7,`VENCIDAS  ${summary.overdue}`,true,"0.72 0.10 0.16");content+=text(708,381,6.5,`${definition.categoryPage}/${definition.categoryPages}`,true,"0.32 0.48 0.44");
    content+="0.06 0.25 0.36 rg 28 327 786 25 re f\n";
    content+=text(35,337,6.5,"EQUIP.",true,"1 1 1");content+=text(82,337,6.5,"MODELO / FRENTE",true,"1 1 1");content+=text(207,337,6.5,"MANUTENÇÃO",true,"1 1 1");content+=text(352,337,6.5,"STATUS",true,"1 1 1");content+=text(422,337,6.5,"ATUAL",true,"1 1 1");content+=text(493,337,6.5,"ÚLTIMA TROCA",true,"1 1 1");content+=text(577,337,6.5,"PRÓXIMA",true,"1 1 1");content+=text(661,337,6.5,"REST./VENC.",true,"1 1 1");
    if(definition.items.length===0)content+=text(298,278,12,"Nenhum registro corresponde aos filtros.",true,"0.33 0.47 0.55");
    definition.items.forEach((item,index)=>{
      const top=307-(index*34);if(index%2===0)content+=`0.968 0.978 0.984 rg 28 ${top-20} 786 33 re f\n`;
      content+=text(35,top,7.5,truncate(item.prefix,9),true);
      content+=text(82,top+3,7,truncate(item.equipment,24),true);content+=text(82,top-9,6,truncate(`Frente ${item.front}`,28),false,"0.39 0.49 0.56");
      content+=text(207,top,7,truncate(item.primary,32),true);
      const statusColor=item.status==="OVERDUE"?"0.72 0.10 0.16":item.status==="NEAR"?"0.88 0.31 0.04":item.status==="WARNING"?"0.64 0.40 0.05":"0.08 0.42 0.31";
      content+=text(352,top,7,reportStatus(item),true,statusColor);
      content+=text(422,top,7,reportValue(item.currentValue,item.unit),false);content+=text(493,top,7,reportValue(item.lastValue??null,item.unit),false);content+=text(577,top,7,reportValue(item.plannedValue,item.unit),false);
      content+=text(661,top,7.5,reportValue(item.differenceValue,item.unit),true,(item.differenceValue??0)<0?"0.76 0.08 0.14":"0.08 0.42 0.31");
      content+=`0.88 0.91 0.93 RG 0.35 w 28 ${top-20} m 814 ${top-20} l S\n`;
    });
    content+="0.86 0.90 0.92 RG 0.6 w 28 35 m 814 35 l S\n";content+=text(34,20,7.5,"Relatório gerado com a lógica atual da Central de Alertas. A exportação não altera dados ou cálculos.",false,"0.42 0.51 0.58");
    return content;
  });
  return buildPdf(pages,{width:842,height:595});
}

export function createCategorizedMaintenanceReportPdf(input:CategorizedMaintenanceReportInput){
  if(input.kind==="ALERTS")return createAlertsMaintenanceReportPdf(input);
  const rowsPerPage=12;
  const normalized=input.items.map((item)=>({...item,category:item.category.trim()||"Sem categoria cadastrada"}));
  const categories=[...new Set(normalized.map((item)=>item.category))].sort((a,b)=>a.localeCompare(b,"pt-BR",{sensitivity:"base"}));
  const pageDefinitions:Array<{category:string;items:CategorizedReportItem[];categoryPage:number;categoryPages:number;summary:ReturnType<typeof reportSummary>}>=[];
  if(categories.length===0){pageDefinitions.push({category:"SEM REGISTROS",items:[],categoryPage:1,categoryPages:1,summary:reportSummary([])});}
  for(const category of categories){
    const categoryItems=normalized.filter((item)=>item.category===category);const categoryPages=Math.max(1,Math.ceil(categoryItems.length/rowsPerPage));const summary=reportSummary(categoryItems);
    for(let page=0;page<categoryPages;page++)pageDefinitions.push({category,items:categoryItems.slice(page*rowsPerPage,(page+1)*rowsPerPage),categoryPage:page+1,categoryPages,summary});
  }
  const pages=pageDefinitions.map((definition,pageIndex)=>{
    let content="";
    content+="1 1 1 rg 0 752 595 90 re f\n";content+="0.16 0.48 0.66 rg 0 746 595 6 re f\n";content+=logo(32,773,84);
    content+=text(126,810,8,"MANUTENÇÃO PREVENTIVA",true,"0.08 0.49 0.35");content+=text(126,788,14,truncate(input.title.toUpperCase(),40),true,"0.08 0.25 0.36");
    content+=text(126,770,8,input.kind==="ALERTS"?"CENTRAL DE ALERTAS · ORGANIZADO POR CATEGORIA":"HISTÓRICO · ORGANIZADO POR CATEGORIA",false,"0.31 0.46 0.55");
    content+=text(451,810,7,"GERADO EM",true,"0.31 0.46 0.55");content+=text(451,793,8,truncate(input.generatedAt,22),false,"0.08 0.25 0.36");
    content+="0.955 0.97 0.98 rg 36 666 523 68 re f\n";
    content+=text(45,716,7,`PERÍODO: ${truncate(input.filters.period,70)}`,true,"0.20 0.34 0.43");
    content+=text(45,702,7,`STATUS: ${truncate(input.filters.status,74)}`,false,"0.27 0.40 0.49");
    content+=text(45,688,7,`CATEGORIAS: ${truncate(input.filters.categories,68)}`,false,"0.27 0.40 0.49");
    content+=text(45,674,7,`OUTROS FILTROS: ${truncate(input.filters.other,64)}`,false,"0.27 0.40 0.49");
    content+=text(444,716,7,`TOTAL: ${input.items.length}`,true,"0.08 0.42 0.31");
    content+=text(465,674,7,`PÁG. ${pageIndex+1}/${pageDefinitions.length}`,true,"0.27 0.40 0.49");
    const categoryTitle=definition.categoryPage>1?`CATEGORIA: ${definition.category.toUpperCase()} · CONTINUAÇÃO`:`CATEGORIA: ${definition.category.toUpperCase()}`;
    content+=text(36,643,12,truncate(categoryTitle,68),true,"0.05 0.35 0.52");
    content+="0.91 0.96 0.95 rg 36 590 523 36 re f\n";
    const summary=definition.summary;
    content+=text(44,611,7,`EQUIPAMENTOS: ${summary.equipment}`,true,"0.13 0.38 0.31");content+=text(145,611,7,`REGISTROS: ${summary.records}`,true,"0.13 0.38 0.31");
    content+=text(239,611,7,`NORMAL: ${summary.normal}`,true,"0.13 0.38 0.31");content+=text(315,611,7,`PERTO: ${summary.warning}`,true,"0.65 0.43 0.07");
    content+=text(389,611,7,`URGENTE: ${summary.near}`,true,"0.76 0.33 0.08");content+=text(474,611,7,`VENCIDO: ${summary.overdue}`,true,"0.72 0.12 0.18");
    content+=text(44,596,6,`PÁGINA DA CATEGORIA: ${definition.categoryPage}/${definition.categoryPages}`,false,"0.36 0.50 0.47");
    content+="0.11 0.35 0.49 rg 36 548 523 26 re f\n";
    if(input.kind==="ALERTS"){
      content+=text(43,558,6,"EQUIP.",true,"1 1 1");content+=text(101,558,6,"MODELO / FRENTE",true,"1 1 1");content+=text(211,558,6,"MANUTENÇÃO",true,"1 1 1");content+=text(341,558,6,"STATUS",true,"1 1 1");content+=text(397,558,6,"ATUAL",true,"1 1 1");content+=text(453,558,6,"PRÓXIMA",true,"1 1 1");content+=text(510,558,6,"REST./VENC.",true,"1 1 1");
    }else{
      content+=text(43,558,6,"DATA",true,"1 1 1");content+=text(102,558,6,"EQUIP.",true,"1 1 1");content+=text(165,558,6,"AÇÃO / SERVIÇO",true,"1 1 1");content+=text(340,558,6,"LEITURA",true,"1 1 1");content+=text(405,558,6,"RESPONSÁVEL",true,"1 1 1");content+=text(511,558,6,"STATUS",true,"1 1 1");
    }
    if(definition.items.length===0)content+=text(188,500,11,"Nenhum registro corresponde aos filtros.",true,"0.33 0.47 0.55");
    definition.items.forEach((item,index)=>{
      const top=526-(index*37);if(index%2===0)content+=`0.965 0.975 0.98 rg 36 ${top-21} 523 36 re f\n`;
      if(input.kind==="ALERTS"){
        content+=text(43,top,7,truncate(item.prefix,10),true);
        content+=text(101,top+2,6,truncate(item.equipment,23),true);content+=text(101,top-10,6,truncate(`Frente ${item.front}`,24),false,"0.39 0.49 0.56");
        content+=text(211,top,6,truncate(item.primary,31),true);content+=text(341,top,6,reportStatus(item),true,item.status==="OVERDUE"?"0.72 0.12 0.18":"0.21 0.35 0.44");
        content+=text(397,top,6,reportValue(item.currentValue,item.unit),false);content+=text(453,top,6,reportValue(item.plannedValue,item.unit),false);content+=text(510,top,6,reportValue(item.differenceValue,item.unit),true);
      }else{
        content+=text(43,top,6,truncate(item.date,14),true);content+=text(102,top,7,truncate(item.prefix,10),true);
        content+=text(165,top+2,6,truncate(item.primary,34),true);content+=text(165,top-10,6,truncate(item.secondary,38),false,"0.39 0.49 0.56");
        content+=text(340,top,6,reportValue(item.currentValue,item.unit),false);content+=text(405,top,6,truncate(item.responsible,22),false);content+=text(511,top,6,reportStatus(item),true,item.status==="OVERDUE"?"0.72 0.12 0.18":"0.21 0.35 0.44");
      }
      content+=`0.88 0.91 0.93 RG 0.35 w 36 ${top-21} m 559 ${top-21} l S\n`;
    });
    content+="0.86 0.90 0.92 RG 0.6 w 36 55 m 559 55 l S\n";content+=text(42,36,8,"Relatório somente para consulta. A exportação não altera dados nem cálculos de manutenção.",false,"0.42 0.51 0.58");
    return content;
  });
  return buildPdf(pages);
}

export function createMaintenancePdf(input:MaintenancePdfInput){
  let content="";content+="1 1 1 rg 0 752 595 90 re f\n";content+="0.16 0.48 0.66 rg 0 746 595 6 re f\n";content+=logo(36,772,84);
  content+=text(132,810,16,"MANUTENÇÃO PREVENTIVA",true,"0.08 0.25 0.36");content+=text(132,788,9,input.title.toUpperCase(),false,"0.08 0.49 0.35");
  content+=text(430,810,8,"GERADO EM",true,"0.31 0.46 0.55");content+=text(430,793,9,input.generatedAt,false,"0.08 0.25 0.36");
  let y=714;const sections:PdfSection[]=[{label:"EQUIPAMENTO",value:input.equipment},{label:"CATEGORIA",value:input.category},{label:"MARCA / MODELO",value:`${input.brand} ${input.model}`.trim()||"Não informado"},{label:"DATA DA MANUTENÇÃO",value:input.date},{label:"LEITURA REGISTRADA",value:input.reading},{label:"RESPONSÁVEL",value:input.responsible},{label:"ORDEM DE SERVIÇO",value:input.workOrder}];
  for(let index=0;index<sections.length;index+=2){const left=sections[index],right=sections[index+1];content+="0.94 0.97 0.98 rg 36 "+(y-24)+" 523 50 re f\n";content+=text(48,y,8,left.label,true,"0.34 0.47 0.56");content+=text(48,y-18,11,left.value,true);if(right){content+=text(310,y,8,right.label,true,"0.34 0.47 0.56");content+=text(310,y-18,11,right.value,true);}y-=62;}
  y-=4;content+=text(42,y,10,"SERVIÇOS REALIZADOS",true,"0.05 0.35 0.52");y-=18;
  input.services.forEach((service,index)=>{for(const [lineIndex,line] of wrap(service,76).entries()){content+=text(50,y,10,line,lineIndex===0,"0.17 0.25 0.31");if(lineIndex===0)content+=text(40,y,10,String(index+1)+".",true,"0.10 0.62 0.45");y-=15;}y-=5;});
  y-=4;content+=text(42,y,10,"OBSERVAÇÕES",true,"0.05 0.35 0.52");y-=18;for(const line of wrap(input.notes||"Sem observações.",86)){content+=text(42,y,9,line,false,"0.30 0.39 0.46");y-=14;}
  content+="0.86 0.90 0.92 RG 0.6 w 36 55 m 559 55 l S\n";content+=text(42,36,8,"Documento somente para consulta. Nenhum dado foi alterado na emissão.",false,"0.42 0.51 0.58");
  return buildPdf([content]);
}

export type MaterialRequestPdfItem={description:string;quantityRequested:number;reference:string|null;itemStatus:"PENDING"|"SENT"|"NOT_AVAILABLE";quantitySent:number|null};
export type MaterialRequestPdfInput={
  requestNumber:string;requester:string;serviceFront:string;requestedAt:string;statusLabel:string;notes:string;
  items:MaterialRequestPdfItem[];generatedAt:string;
};
export type MaterialShipmentPdfInput=MaterialRequestPdfInput&{shippedBy:string;shippedAt:string;shipmentNotes:string};

const materialQuantityFormat=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:2});
const materialItemStatusLabels:Record<MaterialRequestPdfItem["itemStatus"],string>={PENDING:"PENDENTE",SENT:"ENVIADO",NOT_AVAILABLE:"NÃO DISPONÍVEL"};
const materialItemStatusColor:Record<MaterialRequestPdfItem["itemStatus"],string>={PENDING:"0.42 0.51 0.58",SENT:"0.08 0.42 0.31",NOT_AVAILABLE:"0.72 0.10 0.16"};

function materialRequestPdfPages(input:MaterialRequestPdfInput,mode:"REQUEST"|"SHIPMENT",shipment?:{shippedBy:string;shippedAt:string;shipmentNotes:string}){
  const rowsPerPage=10;
  const pageCount=Math.max(1,Math.ceil(input.items.length/rowsPerPage));
  return Array.from({length:pageCount},(_,pageIndex)=>{
    const items=input.items.slice(pageIndex*rowsPerPage,(pageIndex+1)*rowsPerPage);
    let content="";
    content+="1 1 1 rg 0 752 595 90 re f\n";content+="0.16 0.48 0.66 rg 0 746 595 6 re f\n";content+=logo(36,772,84);
    content+=text(132,810,15,mode==="REQUEST"?"SOLICITAÇÃO DE MATERIAIS":"COMPROVANTE DE ENVIO DE MATERIAIS",true,"0.08 0.25 0.36");
    content+=text(132,790,8,"FRENTE DE SERVIÇO · CONTROLE INTERNO",false,"0.08 0.49 0.35");
    content+=text(132,774,9,`PEDIDO ${input.requestNumber}`,true,"0.16 0.48 0.66");
    content+=text(430,810,7,"GERADO EM",true,"0.31 0.46 0.55");content+=text(430,793,8,truncate(input.generatedAt,27),false,"0.08 0.25 0.36");
    content+=text(430,776,7,`PÁGINA ${pageIndex+1}/${pageCount}`,true,"0.16 0.48 0.66");

    content+="0.955 0.972 0.98 rg 36 700 523 40 re f\n";
    content+=text(46,730,7,"SOLICITANTE",true,"0.34 0.47 0.56");content+=text(46,714,9,truncate(input.requester,42),true);
    content+=text(310,730,7,"FRENTE DE SERVIÇO / OBRA / SETOR",true,"0.34 0.47 0.56");content+=text(310,714,9,truncate(input.serviceFront,34),true);
    content+="0.955 0.972 0.98 rg 36 654 523 40 re f\n";
    content+=text(46,684,7,"DATA DA SOLICITAÇÃO",true,"0.34 0.47 0.56");content+=text(46,668,9,truncate(input.requestedAt,30),true);
    content+=text(310,684,7,"STATUS",true,"0.34 0.47 0.56");content+=text(310,668,9,truncate(input.statusLabel,30),true,"0.08 0.42 0.31");
    let bandBottom=654;
    if(mode==="SHIPMENT"&&shipment){
      content+="0.955 0.972 0.98 rg 36 608 523 40 re f\n";
      content+=text(46,638,7,"ENVIADO POR",true,"0.34 0.47 0.56");content+=text(46,622,9,truncate(shipment.shippedBy,42),true);
      content+=text(310,638,7,"DATA DO ENVIO",true,"0.34 0.47 0.56");content+=text(310,622,9,truncate(shipment.shippedAt,30),true);
      bandBottom=608;
    }

    const tableHeaderTop=bandBottom-6;const tableHeaderBottom=tableHeaderTop-24;
    content+=`0.11 0.35 0.49 rg 36 ${tableHeaderBottom} 523 24 re f\n`;
    if(mode==="REQUEST"){
      content+=text(44,tableHeaderBottom+9,7,"DESCRIÇÃO",true,"1 1 1");
      content+=text(400,tableHeaderBottom+9,7,"QUANTIDADE",true,"1 1 1");
      content+=text(470,tableHeaderBottom+9,7,"REFERÊNCIA",true,"1 1 1");
    }else{
      content+=text(40,tableHeaderBottom+9,6.5,"DESCRIÇÃO",true,"1 1 1");
      content+=text(255,tableHeaderBottom+9,6.5,"QTD. SOLIC.",true,"1 1 1");
      content+=text(315,tableHeaderBottom+9,6.5,"REFERÊNCIA",true,"1 1 1");
      content+=text(400,tableHeaderBottom+9,6.5,"STATUS",true,"1 1 1");
      content+=text(470,tableHeaderBottom+9,6.5,"QTD. ENVIADA",true,"1 1 1");
    }

    const firstRowTop=tableHeaderBottom-25;
    if(items.length===0)content+=text(190,firstRowTop-20,11,"Nenhum item nesta página.",true,"0.33 0.47 0.55");
    items.forEach((item,index)=>{
      const top=firstRowTop-(index*30);
      if(index%2===0)content+=`0.968 0.978 0.984 rg 36 ${top-16} 523 30 re f\n`;
      if(mode==="REQUEST"){
        content+=text(44,top,8,truncate(item.description,46),true);
        content+=text(400,top,8,materialQuantityFormat.format(item.quantityRequested),false);
        content+=text(470,top,8,truncate(item.reference??"—",18),false);
      }else{
        content+=text(40,top,7.5,truncate(item.description,34),true);
        content+=text(255,top,7.5,materialQuantityFormat.format(item.quantityRequested),false);
        content+=text(315,top,7.5,truncate(item.reference??"—",14),false);
        content+=text(400,top,7,materialItemStatusLabels[item.itemStatus],true,materialItemStatusColor[item.itemStatus]);
        content+=text(470,top,7.5,item.quantitySent===null?"—":materialQuantityFormat.format(item.quantitySent),true);
      }
      content+=`0.88 0.91 0.93 RG 0.35 w 36 ${top-16} m 559 ${top-16} l S\n`;
    });

    if(pageIndex===pageCount-1){
      const lastRowBottom=firstRowTop-(Math.max(items.length,1)-1)*30-16;
      let noteY=lastRowBottom-24;
      content+=text(42,noteY,9,"OBSERVAÇÕES",true,"0.05 0.35 0.52");noteY-=15;
      for(const line of wrap(input.notes||"Sem observações.",90)){content+=text(42,noteY,8,line,false,"0.30 0.39 0.46");noteY-=13;}
      if(mode==="SHIPMENT"&&shipment){
        noteY-=8;content+=text(42,noteY,9,"OBSERVAÇÕES DO ENVIO",true,"0.05 0.35 0.52");noteY-=15;
        for(const line of wrap(shipment.shipmentNotes||"Sem observações.",90)){content+=text(42,noteY,8,line,false,"0.30 0.39 0.46");noteY-=13;}
      }
    }

    content+="0.86 0.90 0.92 RG 0.6 w 36 40 m 559 40 l S\n";
    content+=text(42,26,7.5,"Documento gerado pelo sistema de controle de manutenção. Nenhum dado foi alterado na emissão.",false,"0.42 0.51 0.58");
    return content;
  });
}

export function createMaterialRequestPdf(input:MaterialRequestPdfInput){
  return buildPdf(materialRequestPdfPages(input,"REQUEST"));
}
export function createMaterialShipmentPdf(input:MaterialShipmentPdfInput){
  return buildPdf(materialRequestPdfPages(input,"SHIPMENT",{shippedBy:input.shippedBy,shippedAt:input.shippedAt,shipmentNotes:input.shipmentNotes}));
}

export function formatPdfDate(value:string){if(!value)return "Sem data";const date=new Date(value);return Number.isNaN(date.getTime())?value:ptFormatter.format(date);}

export type ProductPdfItem={tag:string;name:string;reference:string;price:number;supplier:string;application:string;needsReview:boolean;stock?:number};
type ProductsListPdfInput={items:ProductPdfItem[];generatedAt:string;filters:string;total:number};
const productPriceFormat=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});

export function createProductsListPdf(input:ProductsListPdfInput){
  const perPage=18;const pageCount=Math.max(1,Math.ceil(input.items.length/perPage));
  const pages=Array.from({length:pageCount},(_,pageIndex)=>{
    const items=input.items.slice(pageIndex*perPage,(pageIndex+1)*perPage);let content="";
    content+="1 1 1 rg 0 752 595 90 re f\n";content+="0.16 0.48 0.66 rg 0 746 595 6 re f\n";content+=logo(36,774,88);
    content+=text(136,810,9,"MANUTENÇÃO PREVENTIVA",true,"0.08 0.49 0.35");content+=text(136,787,16,"PRODUTOS",true,"0.08 0.25 0.36");content+=text(136,770,8,truncate(input.filters,72),false,"0.31 0.46 0.55");
    content+=text(430,810,8,"GERADO EM",true,"0.31 0.46 0.55");content+=text(430,793,9,input.generatedAt,false,"0.08 0.25 0.36");
    content+="0.96 0.97 0.98 rg 36 704 523 28 re f\n";
    content+=text(46,715,8,`RESULTADOS: ${input.total}`,true,"0.15 0.27 0.36");content+=text(444,715,8,`PÁGINA ${pageIndex+1}/${pageCount}`,true,"0.15 0.27 0.36");
    content+="0.11 0.35 0.49 rg 36 666 523 25 re f\n";
    content+=text(43,675,7,"TAG",true,"1 1 1");content+=text(90,675,7,"NOME / REFERÊNCIA",true,"1 1 1");content+=text(300,675,7,"PREÇO",true,"1 1 1");content+=text(352,675,7,"ESTOQUE",true,"1 1 1");content+=text(398,675,7,"FORNECEDOR",true,"1 1 1");content+=text(475,675,7,"APLICAÇÃO",true,"1 1 1");
    if(items.length===0){content+=text(200,615,12,"Nenhum produto corresponde aos filtros.",true,"0.33 0.47 0.55");}
    items.forEach((item,index)=>{
      const top=641-(index*31);if(index%2===0)content+=`0.965 0.975 0.98 rg 36 ${top-16} 523 30 re f\n`;
      content+=text(43,top,8,truncate(item.tag,10),true);
      content+=text(90,top+2,7,truncate(item.name,40),true);content+=text(90,top-10,6,truncate(item.reference||"Sem referência",40),false,"0.39 0.49 0.56");
      content+=text(300,top,7,productPriceFormat.format(item.price),false);
      content+=text(352,top,7,item.stock===undefined?"—":item.stock.toLocaleString("pt-BR",{maximumFractionDigits:2}),true);
      content+=text(398,top,7,truncate(item.supplier||"—",14),false);
      content+=text(475,top,7,truncate(item.application||"Uso geral",16),false,item.needsReview?"0.72 0.13 0.18":"0.15 0.27 0.36");
      content+=`0.88 0.91 0.93 RG 0.35 w 36 ${top-16} m 559 ${top-16} l S\n`;
    });
    content+="0.86 0.90 0.92 RG 0.6 w 36 55 m 559 55 l S\n";content+=text(42,36,8,"Relatório gerado com os dados atuais do módulo Produtos. Nenhum registro foi alterado.",false,"0.42 0.51 0.58");
    return content;
  });
  return buildPdf(pages);
}
import { PDF_LOGO_HEIGHT,PDF_LOGO_JPEG_BASE64,PDF_LOGO_WIDTH } from "./pdf-logo";

export type DailyHistoryPdfItem={date:string;prefix:string;equipment:string;operator:string;operatorNote:string;front:string;location:string;worked:string;status:string;attention:boolean};
type DailyHistoryPdfInput={items:DailyHistoryPdfItem[];generatedAt:string;total:number;truncated:boolean;filters:{period:string;front:string;operators:string;search:string}};

// Histórico de Registros Diários (Controle Diário): paisagem, mesmas colunas da listagem da tela.
export function createDailyHistoryPdf(input:DailyHistoryPdfInput){
  const perPage=15;const pageCount=Math.max(1,Math.ceil(input.items.length/perPage));
  const pages=Array.from({length:pageCount},(_,pageIndex)=>{
    const items=input.items.slice(pageIndex*perPage,(pageIndex+1)*perPage);let content="";
    content+="1 1 1 rg 0 514 842 81 re f\n";content+="0.16 0.48 0.66 rg 0 514 842 5 re f\n";content+=logo(28,531,88);
    content+=text(130,570,8,"JC SERVIÇOS FLORESTAIS · MANUTENÇÃO PREVENTIVA",true,"0.08 0.49 0.35");content+=text(130,548,16,"HISTÓRICO DE REGISTROS DIÁRIOS",true,"0.08 0.25 0.36");content+=text(130,531,7.5,"CONTROLE DIÁRIO · ORDENADO POR DATA (MAIS RECENTE PRIMEIRO)",false,"0.31 0.46 0.55");
    content+=text(674,570,7,"GERADO EM",true,"0.31 0.46 0.55");content+=text(674,553,8,truncate(input.generatedAt,24),false,"0.08 0.25 0.36");content+=text(674,536,7,`PÁGINA ${pageIndex+1}/${pageCount}`,true,"0.16 0.48 0.66");
    const cards=[{x:28,width:170,label:"PERÍODO",value:input.filters.period},{x:204,width:150,label:"FRENTE DE SERVIÇO",value:input.filters.front},{x:360,width:250,label:"COLABORADORES",value:input.filters.operators},{x:616,width:198,label:"BUSCA (EQUIPAMENTO / OPERADOR)",value:input.filters.search}];
    for(const card of cards){content+=`0.96 0.975 0.98 rg ${card.x} 455 ${card.width} 48 re f\n`;content+=text(card.x+10,487,6.5,card.label,true,"0.34 0.47 0.56");content+=text(card.x+10,469,8,truncate(card.value,Math.floor(card.width/4.7)),true,"0.11 0.24 0.32");}
    content+="0.91 0.97 0.95 rg 28 419 786 26 re f\n";
    content+=text(39,429,7.5,`REGISTROS: ${input.total}`,true,"0.08 0.38 0.29");
    if(input.truncated)content+=text(200,429,7,`Exibindo os primeiros ${input.items.length} registros — refine os filtros para exportar o restante.`,true,"0.64 0.40 0.05");
    content+="0.06 0.25 0.36 rg 28 383 786 25 re f\n";
    content+=text(35,393,6.5,"DATA",true,"1 1 1");content+=text(92,393,6.5,"EQUIPAMENTO",true,"1 1 1");content+=text(232,393,6.5,"OPERADOR",true,"1 1 1");content+=text(420,393,6.5,"FRENTE / LOCAL",true,"1 1 1");content+=text(560,393,6.5,"HORAS/KM TRAB.",true,"1 1 1");content+=text(640,393,6.5,"STATUS",true,"1 1 1");
    if(items.length===0)content+=text(260,330,12,"Nenhum registro encontrado para o período e filtros selecionados.",true,"0.33 0.47 0.55");
    items.forEach((item,index)=>{
      const top=364-(index*22);if(index%2===0)content+=`0.968 0.978 0.984 rg 28 ${top-12} 786 22 re f\n`;
      content+=text(35,top,7.5,item.date,true);
      content+=text(92,top+2,7.5,truncate(item.prefix,14),true);content+=text(92,top-7,5.5,truncate(item.equipment,34),false,"0.39 0.49 0.56");
      content+=text(232,top+2,7,truncate(item.operator,42),true);if(item.operatorNote)content+=text(232,top-7,5.5,truncate(item.operatorNote,52),false,"0.64 0.40 0.05");
      content+=text(420,top+2,7,truncate(item.front,30),false);if(item.location)content+=text(420,top-7,5.5,truncate(item.location,36),false,"0.39 0.49 0.56");
      content+=text(560,top,7.5,item.worked,true);
      content+=text(640,top,6.5,truncate(item.status,48),true,item.attention?"0.64 0.30 0.05":"0.08 0.42 0.31");
      content+=`0.88 0.91 0.93 RG 0.35 w 28 ${top-12} m 814 ${top-12} l S\n`;
    });
    content+="0.86 0.90 0.92 RG 0.6 w 28 35 m 814 35 l S\n";content+=text(34,20,7.5,"Relatório gerado com os registros atuais do Controle Diário, respeitando os filtros ativos. Nenhum registro foi alterado.",false,"0.42 0.51 0.58");
    return content;
  });
  return buildPdf(pages,{width:842,height:595});
}

export type FuelHistoryPdfItem={date:string;type:string;fuel:string;quantity:string;front:string;equipment:string;origin:string;meter:string;responsible:string};
export type FuelBalancePdfItem={fuel:string;balance:string;entries:string;exits:string};
type FuelHistoryPdfInput={items:FuelHistoryPdfItem[];balances:FuelBalancePdfItem[];generatedAt:string;total:number;truncated:boolean;filters:{period:string;front:string;fuel:string;movement:string}};

// Lançamento de Combustível: paisagem, cards de saldo + mesmas colunas do Histórico da tela.
export function createFuelHistoryPdf(input:FuelHistoryPdfInput){
  const perPage=14;const pageCount=Math.max(1,Math.ceil(input.items.length/perPage));
  const pages=Array.from({length:pageCount},(_,pageIndex)=>{
    const items=input.items.slice(pageIndex*perPage,(pageIndex+1)*perPage);let content="";
    content+="1 1 1 rg 0 514 842 81 re f\n";content+="0.16 0.48 0.66 rg 0 514 842 5 re f\n";content+=logo(28,531,88);
    content+=text(130,570,8,"JC SERVIÇOS FLORESTAIS · MANUTENÇÃO PREVENTIVA",true,"0.08 0.49 0.35");content+=text(130,548,16,"MOVIMENTAÇÃO DE COMBUSTÍVEL",true,"0.08 0.25 0.36");content+=text(130,531,7.5,`PERÍODO ${input.filters.period} · ${input.filters.front}`,false,"0.31 0.46 0.55");
    content+=text(674,570,7,"GERADO EM",true,"0.31 0.46 0.55");content+=text(674,553,8,truncate(input.generatedAt,24),false,"0.08 0.25 0.36");content+=text(674,536,7,`PÁGINA ${pageIndex+1}/${pageCount}`,true,"0.16 0.48 0.66");
    const width=Math.min(260,Math.floor(786/Math.max(1,input.balances.length))-8);
    input.balances.forEach((balance,index)=>{const x=28+index*(width+8);content+=`0.96 0.975 0.98 rg ${x} 447 ${width} 58 re f\n`;content+=text(x+10,491,7,truncate(balance.fuel.toUpperCase(),40),true,"0.34 0.47 0.56");content+=text(x+10,471,13,`Saldo ${balance.balance}`,true,"0.08 0.25 0.36");content+=text(x+10,455,7,`Entradas ${balance.entries} · Saídas ${balance.exits}`,false,"0.31 0.46 0.55");});
    content+="0.91 0.97 0.95 rg 28 413 786 24 re f\n";
    content+=text(39,422,7.5,`LANÇAMENTOS: ${input.total} · COMBUSTÍVEL: ${input.filters.fuel} · TIPO: ${input.filters.movement}`,true,"0.08 0.38 0.29");
    if(input.truncated)content+=text(470,422,7,`Exibindo os primeiros ${input.items.length} — refine os filtros para exportar o restante.`,true,"0.64 0.40 0.05");
    content+="0.06 0.25 0.36 rg 28 380 786 24 re f\n";
    const columns:[number,string][]=[[35,"DATA"],[88,"TIPO"],[150,"COMBUSTÍVEL"],[232,"QTD. (L)"],[290,"FRENTE"],[392,"VEÍCULO/MÁQUINA"],[512,"ORIGEM"],[618,"HOD./HORÍM."],[694,"RESPONSÁVEL"]];
    for(const [x,label] of columns)content+=text(x,389,6.5,label,true,"1 1 1");
    if(items.length===0)content+=text(260,330,12,"Nenhum lançamento encontrado para o período e filtros selecionados.",true,"0.33 0.47 0.55");
    items.forEach((item,index)=>{
      const top=362-(index*22);if(index%2===0)content+=`0.968 0.978 0.984 rg 28 ${top-8} 786 22 re f\n`;
      const values:[number,string,number][]=[[35,item.date,10],[88,item.type,12],[150,item.fuel,16],[232,item.quantity,11],[290,item.front,20],[392,item.equipment,23],[512,item.origin,20],[618,item.meter,14],[694,item.responsible,22]];
      for(const [x,value,max] of values)content+=text(x,top,7,truncate(value,max),x===232);
      content+=`0.88 0.91 0.93 RG 0.35 w 28 ${top-8} m 814 ${top-8} l S\n`;
    });
    content+="0.86 0.90 0.92 RG 0.6 w 28 35 m 814 35 l S\n";content+=text(34,20,7.5,"Relatório gerado com os lançamentos atuais de combustível, respeitando os filtros ativos. Nenhum registro foi alterado.",false,"0.42 0.51 0.58");
    return content;
  });
  return buildPdf(pages,{width:842,height:595});
}
