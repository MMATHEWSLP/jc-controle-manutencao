"use client";

import { unzipSync } from "fflate";

export type SpreadsheetReadingRow={rowNumber:number;equipment:string;reading:number|null;readingRaw:string;responsible:string;readingDate:string|null;notes:string;front:string};

const utf8=new TextDecoder("utf-8");
const win1252=new TextDecoder("windows-1252");
const utf16=new TextDecoder("utf-16le");
const freeSector=0xffffffff;
const endOfChain=0xfffffffe;

function headerKey(value:unknown){return String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9]/g,"");}
function cellText(value:unknown){return value===null||value===undefined?"":String(value).trim();}

export function parseBrazilianReading(value:unknown){
  if(typeof value==="number")return Number.isFinite(value)?value:null;
  let raw=cellText(value).replace(/\s+/g,"");if(!raw)return null;
  if(!/^-?[\d.,]+$/.test(raw))return null;
  const comma=raw.lastIndexOf(","),dot=raw.lastIndexOf(".");
  if(comma>=0&&dot>=0){raw=comma>dot?raw.replaceAll(".","").replace(",","."):raw.replaceAll(",","");}
  else if(comma>=0)raw=raw.replaceAll(".","").replace(",",".");
  else if(dot>=0&&/^-?\d{1,3}(\.\d{3})+$/.test(raw))raw=raw.replaceAll(".","");
  const parsed=Number(raw);return Number.isFinite(parsed)?parsed:null;
}

function excelDate(value:unknown){
  if(typeof value==="number"&&Number.isFinite(value)){const date=new Date((value-25569)*86400000);return Number.isNaN(date.getTime())?null:date.toISOString();}
  const raw=cellText(value);if(!raw)return null;
  const br=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(br){const date=new Date(Number(br[3]),Number(br[2])-1,Number(br[1]),Number(br[4]??12),Number(br[5]??0),Number(br[6]??0));return Number.isNaN(date.getTime())?null:date.toISOString();}
  const date=new Date(raw);return Number.isNaN(date.getTime())?null:date.toISOString();
}

function rowsFromMatrix(matrix:unknown[][]){
  const headerIndex=matrix.slice(0,25).findIndex((row)=>{const keys=row.map(headerKey);return keys.some((key)=>key==="EQUIPAMENTO"||key==="PREFIXO")&&keys.includes("LEITURA");});
  if(headerIndex<0)throw new Error("Não encontrei as colunas EQUIPAMENTO e LEITURA na planilha.");
  const headers=matrix[headerIndex].map(headerKey);
  const find=(...names:string[])=>headers.findIndex((header)=>names.includes(header));
  const equipmentColumn=find("EQUIPAMENTO","PREFIXO");const readingColumn=find("LEITURA","NOVALEITURA","KMHORIMETRO","HORIMETROKM");const responsibleColumn=find("RESPONSAVEL","OPERADOR");
  if(equipmentColumn<0||readingColumn<0||responsibleColumn<0)throw new Error("O arquivo precisa ter as colunas EQUIPAMENTO, LEITURA e RESPONSÁVEL.");
  const dateColumn=find("DATAHORA","DATA","DATALEITURA");const notesColumn=find("OBSERVACAO","OBSERVACOES","NOTAS");const frontColumn=find("FRENTE","FRENTEDESERVICO");
  return matrix.slice(headerIndex+1).map((row,index):SpreadsheetReadingRow=>{
    const readingRaw=cellText(row[readingColumn]);
    return {rowNumber:headerIndex+index+2,equipment:cellText(row[equipmentColumn]),reading:parseBrazilianReading(row[readingColumn]),readingRaw,responsible:cellText(row[responsibleColumn]),readingDate:dateColumn>=0?excelDate(row[dateColumn]):null,notes:notesColumn>=0?cellText(row[notesColumn]):"",front:frontColumn>=0?cellText(row[frontColumn]):""};
  }).filter((row)=>row.equipment||row.readingRaw||row.responsible);
}

function parseDelimited(text:string){
  const first=text.split(/\r?\n/).find((line)=>line.trim())??"";const delimiters=[";","\t",","];const delimiter=delimiters.sort((a,b)=>first.split(b).length-first.split(a).length)[0];
  const rows:string[][]=[];let row:string[]=[],value="",quoted=false;
  for(let index=0;index<text.length;index++){
    const character=text[index];
    if(character==='"'){if(quoted&&text[index+1]==='"'){value+='"';index++;}else quoted=!quoted;continue;}
    if(!quoted&&character===delimiter){row.push(value);value="";continue;}
    if(!quoted&&(character==="\n"||character==="\r")){if(character==="\r"&&text[index+1]==="\n")index++;row.push(value);if(row.some((cell)=>cell.trim()))rows.push(row);row=[];value="";continue;}
    value+=character;
  }
  row.push(value);if(row.some((cell)=>cell.trim()))rows.push(row);return rows;
}

function xmlDocument(bytes:Uint8Array){const document=new DOMParser().parseFromString(utf8.decode(bytes),"application/xml");if(document.querySelector("parsererror"))throw new Error("O arquivo Excel está corrompido ou não pôde ser lido.");return document;}
function xlsxMatrix(bytes:Uint8Array){
  const files=unzipSync(bytes);const workbook=files["xl/workbook.xml"],relationships=files["xl/_rels/workbook.xml.rels"];if(!workbook||!relationships)throw new Error("O arquivo XLSX não possui uma pasta de trabalho válida.");
  const workbookXml=xmlDocument(workbook),relsXml=xmlDocument(relationships);const firstSheet=workbookXml.querySelector("sheet");const relationId=firstSheet?.getAttribute("r:id")??firstSheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships","id");
  const relation=[...relsXml.querySelectorAll("Relationship")].find((item)=>item.getAttribute("Id")===relationId);const target=relation?.getAttribute("Target");if(!target)throw new Error("Não encontrei a primeira aba do arquivo Excel.");
  const sheetPath=target.startsWith("/")?target.slice(1):`xl/${target.replace(/^\.\//,"")}`;const sheetBytes=files[sheetPath]??files[sheetPath.replace("xl/xl/","xl/")];if(!sheetBytes)throw new Error("Não foi possível abrir a primeira aba do arquivo Excel.");
  const shared=files["xl/sharedStrings.xml"]?[...xmlDocument(files["xl/sharedStrings.xml"]).querySelectorAll("si")].map((item)=>item.textContent??""):[];
  const sheet=xmlDocument(sheetBytes);const matrix:unknown[][]=[];
  for(const cell of sheet.querySelectorAll("c")){
    const reference=cell.getAttribute("r")??"A1";const columnLetters=reference.match(/[A-Z]+/i)?.[0]?.toUpperCase()??"A";let column=0;for(const letter of columnLetters)column=column*26+letter.charCodeAt(0)-64;column--;
    const row=Math.max(0,Number(reference.match(/\d+/)?.[0]??1)-1);const type=cell.getAttribute("t");const raw=cell.querySelector("v")?.textContent??"";let value:unknown=raw;
    if(type==="s")value=shared[Number(raw)]??"";else if(type==="inlineStr"||type==="str")value=cell.querySelector("is")?.textContent??raw;else if(type==="b")value=raw==="1";else if(raw!==""&&Number.isFinite(Number(raw)))value=Number(raw);
    matrix[row]??=[];matrix[row][column]=value;
  }
  return matrix;
}

function spreadsheetXmlMatrix(bytes:Uint8Array){
  const text=win1252.decode(bytes);const document=new DOMParser().parseFromString(text,"application/xml");if(document.querySelector("parsererror"))throw new Error("Este arquivo .xls antigo não pôde ser lido. Salve-o novamente como .xlsx ou .csv.");
  const matrix:unknown[][]=[];for(const [rowIndex,row] of [...document.getElementsByTagNameNS("*","Row")].entries()){
    matrix[rowIndex]=[];let column=0;for(const cell of [...row.getElementsByTagNameNS("*","Cell")]){const indexed=cell.getAttributeNS("urn:schemas-microsoft-com:office:spreadsheet","Index")??cell.getAttribute("ss:Index");if(indexed)column=Number(indexed)-1;const data=cell.getElementsByTagNameNS("*","Data")[0];const raw=data?.textContent??"";matrix[rowIndex][column]=data?.getAttributeNS("urn:schemas-microsoft-com:office:spreadsheet","Type")==="Number"?Number(raw):raw;column++;}}
  return matrix;
}

function concatSectors(bytes:Uint8Array,sectorSize:number,ids:number[]){const output=new Uint8Array(ids.length*sectorSize);ids.forEach((id,index)=>output.set(bytes.subarray(512+id*sectorSize,512+(id+1)*sectorSize),index*sectorSize));return output;}
function legacyXlsMatrix(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(view.getUint32(0,true)!==0xe011cfd0||view.getUint32(4,true)!==0xe11ab1a1)throw new Error("Formato .xls não reconhecido.");
  const sectorSize=1<<view.getUint16(30,true),miniSectorSize=1<<view.getUint16(32,true);const difat:number[]=[];
  for(let index=0;index<109;index++){const id=view.getUint32(76+index*4,true);if(id!==freeSector)difat.push(id);}
  let difatSector=view.getUint32(68,true);const difatCount=view.getUint32(72,true);for(let count=0;count<difatCount&&difatSector<0xfffffffa;count++){const sectorOffset=512+difatSector*sectorSize;for(let index=0;index<sectorSize/4-1;index++){const id=view.getUint32(sectorOffset+index*4,true);if(id!==freeSector)difat.push(id);}difatSector=view.getUint32(sectorOffset+sectorSize-4,true);}
  const fat:number[]=[];for(const id of difat){const offset=512+id*sectorSize;for(let index=0;index<sectorSize/4;index++)fat.push(view.getUint32(offset+index*4,true));}
  const chain=(start:number,table:number[],limit=100000)=>{const ids:number[]=[];let id=start;const seen=new Set<number>();while(id<0xfffffffa&&!seen.has(id)&&ids.length<limit){seen.add(id);ids.push(id);id=table[id]??endOfChain;}return ids;};
  const directory=concatSectors(bytes,sectorSize,chain(view.getUint32(48,true),fat));const directoryView=new DataView(directory.buffer,directory.byteOffset,directory.byteLength);const entries:Array<{name:string;type:number;start:number;size:number}>=[];
  for(let offset=0;offset+128<=directory.length;offset+=128){const nameLength=directoryView.getUint16(offset+64,true);if(nameLength<2)continue;const name=utf16.decode(directory.subarray(offset,offset+nameLength-2));entries.push({name,type:directory[offset+66],start:directoryView.getUint32(offset+116,true),size:directoryView.getUint32(offset+120,true)});}
  const workbook=entries.find((entry)=>/^(workbook|book)$/i.test(entry.name)),root=entries.find((entry)=>entry.type===5);if(!workbook)throw new Error("Não encontrei a planilha dentro do arquivo .xls.");
  let stream:Uint8Array;
  if(workbook.size<view.getUint32(56,true)&&root){const miniFatBytes=concatSectors(bytes,sectorSize,chain(view.getUint32(60,true),fat).slice(0,view.getUint32(64,true)));const miniFatView=new DataView(miniFatBytes.buffer,miniFatBytes.byteOffset,miniFatBytes.byteLength);const miniFat:number[]=[];for(let index=0;index+4<=miniFatBytes.length;index+=4)miniFat.push(miniFatView.getUint32(index,true));const miniStream=concatSectors(bytes,sectorSize,chain(root.start,fat)).subarray(0,root.size);const ids=chain(workbook.start,miniFat);stream=new Uint8Array(ids.length*miniSectorSize);ids.forEach((id,index)=>stream.set(miniStream.subarray(id*miniSectorSize,(id+1)*miniSectorSize),index*miniSectorSize));stream=stream.subarray(0,workbook.size);}
  else stream=concatSectors(bytes,sectorSize,chain(workbook.start,fat)).subarray(0,workbook.size);
  const biff=new DataView(stream.buffer,stream.byteOffset,stream.byteLength);const records:Array<{type:number,start:number,length:number}>=[];for(let offset=0;offset+4<=stream.length;){const type=biff.getUint16(offset,true),length=biff.getUint16(offset+2,true);if(offset+4+length>stream.length)break;records.push({type,start:offset+4,length});offset+=4+length;}
  const sstRecord=records.find((record)=>record.type===0x00fc);const shared:string[]=[];
  if(sstRecord){let offset=sstRecord.start+8;const end=sstRecord.start+sstRecord.length;const unique=biff.getUint32(sstRecord.start+4,true);for(let index=0;index<unique&&offset+3<=end;index++){const length=biff.getUint16(offset,true);offset+=2;const flags=stream[offset++];let richRuns=0,extension=0;if(flags&0x08){richRuns=biff.getUint16(offset,true);offset+=2;}if(flags&0x04){extension=biff.getUint32(offset,true);offset+=4;}const byteLength=length*((flags&0x01)?2:1);if(offset+byteLength>end)break;shared.push((flags&0x01?utf16:win1252).decode(stream.subarray(offset,offset+byteLength)));offset+=byteLength+richRuns*4+extension;}}
  const bound=records.find((record)=>record.type===0x0085);const sheetStart=bound?biff.getUint32(bound.start,true):records.find((record)=>record.type===0x0809&&record.start>20)?.start??0;const matrix:unknown[][]=[];
  const put=(row:number,column:number,value:unknown)=>{matrix[row]??=[];matrix[row][column]=value;};
  for(const record of records){if(record.start<sheetStart||record.length<6)continue;const row=biff.getUint16(record.start,true),column=biff.getUint16(record.start+2,true);
    if(record.type===0x00fd&&record.length>=10)put(row,column,shared[biff.getUint32(record.start+6,true)]??"");
    else if(record.type===0x0203&&record.length>=14)put(row,column,biff.getFloat64(record.start+6,true));
    else if(record.type===0x027e&&record.length>=10){const rk=biff.getUint32(record.start+6,true);let value:number;if(rk&2)value=biff.getInt32(record.start+6,true)>>2;else{const buffer=new ArrayBuffer(8),rkView=new DataView(buffer);rkView.setUint32(4,rk&0xfffffffc,true);value=rkView.getFloat64(0,true);}put(row,column,rk&1?value/100:value);}
    else if(record.type===0x0204&&record.length>=8){const length=biff.getUint16(record.start+6,true),flags=stream[record.start+8]??0,start=record.start+9;put(row,column,(flags&1?utf16:win1252).decode(stream.subarray(start,start+length*((flags&1)?2:1))));}
  }
  if(matrix.length===0)throw new Error("Não encontrei linhas legíveis no arquivo .xls.");return matrix;
}

export async function readSpreadsheetFile(file:File){
  if(file.size>8*1024*1024)throw new Error("O arquivo ultrapassa o limite de 8 MB.");const extension=file.name.split(".").pop()?.toLowerCase();if(!extension||!["xlsx","xls","csv"].includes(extension))throw new Error("Selecione um arquivo .xlsx, .xls ou .csv.");
  const bytes=new Uint8Array(await file.arrayBuffer());let matrix:unknown[][];
  if(extension==="csv")matrix=parseDelimited(utf8.decode(bytes));
  else if(bytes[0]===0x50&&bytes[1]===0x4b)matrix=xlsxMatrix(bytes);
  else if(bytes[0]===0xd0&&bytes[1]===0xcf)matrix=legacyXlsMatrix(bytes);
  else if(win1252.decode(bytes.subarray(0,500)).includes("Workbook"))matrix=spreadsheetXmlMatrix(bytes);
  else matrix=parseDelimited(win1252.decode(bytes));
  const rows=rowsFromMatrix(matrix);if(rows.length===0)throw new Error("A planilha não possui linhas preenchidas para analisar.");if(rows.length>1000)throw new Error("Importe no máximo 1.000 linhas por arquivo.");return rows;
}
