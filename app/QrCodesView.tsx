"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import QRCode from "qrcode";

type Equipment={id:number;prefix:string;type:string;brand:string;model:string;situation:string;tone:string;qrToken:string|null};
type SystemData={equipment:Equipment[]};

const qrStatus=(item:Equipment)=>item.situation==="Atenção"?"PRÓXIMA TROCA":item.situation==="Urgente"?"URGENTE":item.situation==="Vencido"?"VENCIDA":item.situation==="Normal"?"NORMAL":"SEM HISTÓRICO";
const htmlEntities:Record<string,string>={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"};
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,(character)=>htmlEntities[character]);

function QrPreview({url,prefix,size=92}:{url:string;prefix:string;size?:number}){
  const [src,setSrc]=useState("");
  useEffect(()=>{if(!url)return;QRCode.toDataURL(url,{width:size,margin:2,errorCorrectionLevel:"M"}).then(setSrc).catch(()=>setSrc(""));},[url,size]);
  return src?<img className="qr-preview" src={src} alt={`QR Code do equipamento ${prefix}`}/>:<span className="qr-loading">Gerando...</span>;
}

export default function QrCodesView({data}:{data:SystemData}){
  const [query,setQuery]=useState("");const [category,setCategory]=useState("TODOS");const [status,setStatus]=useState("TODOS");const [origin]=useState(()=>typeof window==="undefined"?"":window.location.origin);const [busy,setBusy]=useState(false);
  const categories=[...new Set(data.equipment.map((item)=>item.prefix.split("-")[0].toUpperCase()))].sort();const normalized=query.trim().toLowerCase();
  const available=data.equipment.filter((item)=>item.qrToken);const items=available.filter((item)=>(category==="TODOS"||item.prefix.toUpperCase().startsWith(`${category}-`))&&(status==="TODOS"||qrStatus(item)===status)&&(!normalized||[item.prefix,item.type,item.brand,item.model].some((value)=>value.toLowerCase().includes(normalized))));
  const urlFor=(item:Equipment)=>item.qrToken&&origin?`${origin}/equipamento/qr/${encodeURIComponent(item.qrToken)}`:"";
  const labelHtml=(item:Equipment,src:string)=>`<article class="label"><h2>JC SERVIÇOS FLORESTAIS</h2><h1>EQUIPAMENTO: ${escapeHtml(item.prefix)}</h1><img src="${src}" alt="QR Code ${escapeHtml(item.prefix)}"><p>ESCANEIE PARA CONSULTAR A MANUTENÇÃO</p></article>`;
  async function printLabels(selected:Equipment[],title:string){
    if(!selected.length||!origin)return;const popup=window.open("","_blank");if(!popup)return;popup.document.write("<p style='font-family:Arial;padding:24px'>Gerando etiquetas...</p>");setBusy(true);
    try{
      const labels=await Promise.all(selected.map(async(item)=>labelHtml(item,await QRCode.toDataURL(urlFor(item),{width:640,margin:3,errorCorrectionLevel:"M"}))));
      popup.document.open();popup.document.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>@page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;font-family:Arial;color:#000}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8mm}.label{min-height:128mm;border:2px solid #111;border-radius:6px;padding:9mm;text-align:center;break-inside:avoid;display:flex;flex-direction:column;align-items:center;justify-content:center}.label h2{font-size:13px;margin:0 0 5mm}.label h1{font-size:20px;margin:0 0 5mm}.label img{width:72mm;height:72mm;image-rendering:pixelated}.label p{font-size:11px;font-weight:800;margin:5mm 0 0}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><main class="grid">${labels.join("")}</main><script>window.onload=()=>window.print()<\/script></body></html>`);popup.document.close();
    }finally{setBusy(false);}
  }
  async function download(item:Equipment){const url=urlFor(item);if(!url)return;const src=await QRCode.toDataURL(url,{width:1200,margin:4,errorCorrectionLevel:"M"});const anchor=document.createElement("a");anchor.href=src;anchor.download=`QR-${item.prefix}.png`;anchor.click();}
  const categoryItems=category==="TODOS"?[]:available.filter((item)=>item.prefix.toUpperCase().startsWith(`${category}-`));
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">IDENTIFICAÇÃO PERMANENTE</p><h1>QR Codes dos equipamentos</h1><span>Cada QR abre uma página permanente que consulta leitura, planos, alertas e Histórico diretamente no banco.</span></div></div>
    <div className="qr-actions-bar"><button className="primary" onClick={()=>printLabels(available,"QR Codes de todos os equipamentos")} disabled={busy||!origin}>▣ {busy?"Gerando etiquetas...":"Imprimir todos"}</button><button className="secondary" onClick={()=>printLabels(categoryItems,`QR Codes da categoria ${category}`)} disabled={busy||!categoryItems.length}>▤ Imprimir por categoria</button><span>{available.length} QR Codes permanentes</span></div>
    <article className="panel module-panel qr-module"><div className="qr-filter-grid"><label className="page-search"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar equipamento, marca ou modelo..."/></label><select value={category} onChange={(event)=>setCategory(event.target.value)}><option value="TODOS">Todas as categorias</option>{categories.map((item)=><option value={item} key={item}>{item}</option>)}</select><select value={status} onChange={(event)=>setStatus(event.target.value)}><option value="TODOS">Todos os status</option><option value="NORMAL">Normal</option><option value="PRÓXIMA TROCA">Próxima troca</option><option value="URGENTE">Urgente</option><option value="VENCIDA">Vencida</option><option value="SEM HISTÓRICO">Sem histórico</option></select><span className="live-data-badge">{items.length} ENCONTRADOS</span></div><div className="table-scroll"><table className="qr-table"><thead><tr><th>Equipamento</th><th>Categoria</th><th>QR Code</th><th>Status</th><th>Visualizar</th><th>Imprimir</th><th>Download</th></tr></thead><tbody>{items.map((item)=>{const url=urlFor(item);return <tr key={item.id}><td><div className="qr-equipment"><span>{item.prefix.slice(0,2)}</span><div><strong>{item.prefix}</strong><small>{item.brand} {item.model}</small></div></div></td><td><span className="category-pill">{item.prefix.split("-")[0]}</span></td><td><QrPreview url={url} prefix={item.prefix}/></td><td><span className={`status-pill ${item.tone}`}>{qrStatus(item)}</span></td><td><a className="qr-row-button" href={url||undefined} target="_blank" rel="noreferrer">Visualizar</a></td><td><button className="qr-row-button" onClick={()=>printLabels([item],`QR Code ${item.prefix}`)}>Imprimir</button></td><td><button className="qr-row-button download" onClick={()=>download(item)}>PNG</button></td></tr>;})}</tbody></table></div>{items.length===0&&<div className="empty-state">Nenhum equipamento corresponde aos filtros.</div>}</article>
  </>;
}
