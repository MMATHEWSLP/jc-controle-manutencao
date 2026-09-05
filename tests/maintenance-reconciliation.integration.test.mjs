import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { recalculateMaintenanceCycles } from "../lib/maintenance-recalculation.ts";

const projectRoot=process.env.SITES_PROJECT_ROOT??process.cwd();

class LocalStatement {
  constructor(database,sql,bindings=[]){this.database=database;this.sql=sql;this.bindings=bindings;}
  bind(...bindings){return new LocalStatement(this.database,this.sql,bindings);}
  async all(){return {results:this.database.prepare(this.sql).all(...this.bindings)};}
  async first(){return this.database.prepare(this.sql).get(...this.bindings)??null;}
  async run(){return this.database.prepare(this.sql).run(...this.bindings);}
}

class LocalD1 {
  constructor(database){this.database=database;}
  prepare(sql){return new LocalStatement(this.database,sql);}
  async batch(statements){
    this.database.exec("BEGIN");
    try{const results=[];for(const statement of statements)results.push(await statement.run());this.database.exec("COMMIT");return results;}
    catch(error){this.database.exec("ROLLBACK");throw error;}
  }
}

// SQLite não conhece to_char()/AT TIME ZONE (sintaxe exclusiva do Postgres,
// usada pelo padrão de timestamp do projeto em db/schema.ts). Trocamos pelo
// equivalente em SQLite só para este banco de teste em memória; as migrations
// reais aplicadas no Postgres continuam intactas.
const PG_ISO_NOW_DEFAULT=`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const SQLITE_ISO_NOW_DEFAULT=`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

function migratedDatabase(){
  const database=new DatabaseSync(":memory:");
  // SQLite não suporta ALTER TABLE ... ADD CONSTRAINT (chaves estrangeiras só
  // podem ser declaradas na criação da tabela). Como este banco de teste em
  // memória nunca depende de rejeição por violação de FK, essas linhas —
  // geradas pelo Drizzle só para o Postgres real — são descartadas aqui.
  database.exec("PRAGMA foreign_keys=OFF");
  for(const file of readdirSync(join(projectRoot,"drizzle")).filter((name)=>name.endsWith(".sql")).sort()){
    const sql=readFileSync(join(projectRoot,"drizzle",file),"utf8")
      .replaceAll("--> statement-breakpoint","")
      .replaceAll(PG_ISO_NOW_DEFAULT,SQLITE_ISO_NOW_DEFAULT)
      .replaceAll(/ USING \w+ /g," ")
      .replaceAll('"id" serial PRIMARY KEY NOT NULL','"id" integer PRIMARY KEY')
      .split("\n").filter((line)=>!/ALTER TABLE .* ADD CONSTRAINT /.test(line)).join("\n");
    database.exec(sql);
  }
  return database;
}

function addEquipment(database,{prefix,type,controlType,currentHours,currentKm}){
  return Number(database.prepare(`INSERT INTO equipment
    (code,prefix,type,brand,model,serial_number,current_hours,current_km,control_type,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .run(`TEST-${prefix}`,prefix,type,"Sites QA","Reconciliação",`SER-${prefix}`,currentHours,currentKm,controlType).lastInsertRowid);
}

function maintenanceTypeId(database,name){
  return Number(database.prepare("SELECT id FROM maintenance_types WHERE name=?").get(name).id);
}

function enableTypes(database,equipmentId,names){
  const insert=database.prepare(`INSERT INTO equipment_maintenance_types
    (equipment_id,maintenance_type_id,applicable,created_at,updated_at) VALUES (?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  for(const name of names)insert.run(equipmentId,maintenanceTypeId(database,name));
}

function addImported(database,{prefix,service,reading,unit,date}){
  database.prepare(`INSERT INTO imported_maintenance_history
    (prefix,service,reading_raw,reading_value,control_type,performed_at,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'REGRESSION_TEST',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .run(prefix,service,String(reading),reading,unit,date);
}

// maintenance_types e maintenance_interval_configs não são populados por
// migration (são dados de referência cadastrados manualmente no ambiente
// real) — este banco de teste em memória precisa da própria carga mínima
// para exercitar a mesma lógica de associação/cálculo usada em produção.
// `configs` é uma lista de {category,unit,interval,names}, uma entrada por
// combinação de categoria+unidade+intervalo (os nomes dentro dela recebem
// o mesmo intervalo). Um nome sem nenhuma configuração fica de propósito
// sem intervalo padrão, simulando uma categoria ainda não configurada.
function seedMaintenanceTypes(database,names){
  const insertType=database.prepare(`INSERT OR IGNORE INTO maintenance_types (name,category,active,created_at,updated_at) VALUES (?,'OIL',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  for(const name of names)insertType.run(name);
}
function seedIntervalConfigs(database,configs){
  const insertConfig=database.prepare(`INSERT INTO maintenance_interval_configs (category,maintenance_type_id,interval_value,unit,active,created_at,updated_at) VALUES (?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  for(const {category,unit,interval,names} of configs)
    for(const name of names)insertConfig.run(category,maintenanceTypeId(database,name),interval,unit);
}

test("reconcilia e calcula o Plano independentemente da ordem entre Histórico e cadastro",async()=>{
  const database=migratedDatabase();const d1=new LocalD1(database);
  seedMaintenanceTypes(database,["TROCA DE ÓLEO DO MOTOR","TROCA DE ÓLEO DA CAIXA DE MARCHA","TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO","TROCA DE ÓLEO DA TRANSMISSÃO"]);
  seedIntervalConfigs(database,[
    {category:"CM",unit:"KM",interval:12000,names:["TROCA DE ÓLEO DO MOTOR"]},
    {category:"CM",unit:"KM",interval:40000,names:["TROCA DE ÓLEO DA CAIXA DE MARCHA"]},
    {category:"CM",unit:"KM",interval:30000,names:["TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO"]},
    {category:"PC",unit:"HOURS",interval:250,names:["TROCA DE ÓLEO DO MOTOR"]},
    {category:"PC",unit:"HOURS",interval:2000,names:["TROCA DE ÓLEO DA TRANSMISSÃO"]},
  ]);
  const cmPrefix="CM-REG-27";
  addImported(database,{prefix:" cm – reg – 27 ",service:"Troca de óleo da caixa de marcha",reading:94386,unit:"KM",date:"2025-05-11"});
  addImported(database,{prefix:cmPrefix,service:"Troca de óleo do motor",reading:95123,unit:"KM",date:"2025-08-15"});
  addImported(database,{prefix:cmPrefix,service:"TROCA DE ÓLEO DO MOTOR",reading:124673,unit:"KM",date:"2026-06-20"});
  addImported(database,{prefix:cmPrefix,service:"Troca de óleo do diferencial dianteiro",reading:125147,unit:"KM",date:"2026-07-11"});
  addImported(database,{prefix:cmPrefix,service:"Troca de óleo do diferencial traseiro",reading:125147,unit:"KM",date:"2026-07-11"});
  const cmId=addEquipment(database,{prefix:cmPrefix,type:"Caminhão",controlType:"HOURS",currentHours:133665,currentKm:132718});
  enableTypes(database,cmId,["TROCA DE ÓLEO DA CAIXA DE MARCHA","TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO","TROCA DE ÓLEO DO MOTOR"]);
  await recalculateMaintenanceCycles(d1,{equipmentId:cmId,force:true,notify:false});

  assert.deepEqual({...database.prepare("SELECT current_hours,current_km,control_type FROM equipment WHERE id=?").get(cmId)},{current_hours:0,current_km:133665,control_type:"KM"});
  const cmPlans=database.prepare(`SELECT t.name,p.trigger_mode,p.interval_hours,p.interval_km,p.last_km,p.next_km
    FROM maintenance_plans p INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id
    WHERE p.equipment_id=? AND p.active=1 ORDER BY t.name`).all(cmId);
  assert.deepEqual(cmPlans.map((plan)=>[plan.name,plan.trigger_mode,plan.interval_hours,plan.interval_km,plan.last_km,plan.next_km]),[
    ["TROCA DE ÓLEO DA CAIXA DE MARCHA","KM",null,40000,94386,134386],
    ["TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","KM",null,30000,125147,155147],
    ["TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO","KM",null,30000,125147,155147],
    ["TROCA DE ÓLEO DO MOTOR","KM",null,12000,124673,136673],
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM imported_maintenance_history WHERE equipment_id=? AND maintenance_type_id IS NOT NULL").get(cmId).total,5);
  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM imported_maintenance_history WHERE prefix IN (?,?)").get(cmPrefix," cm – reg – 27 ").total,5,"a reconciliação não pode duplicar o Histórico");

  const pcPrefix="PC-REG-20";
  const pcId=addEquipment(database,{prefix:pcPrefix,type:"Escavadeira",controlType:"HOURS",currentHours:7180,currentKm:0});
  enableTypes(database,pcId,["TROCA DE ÓLEO DO MOTOR","TROCA DE ÓLEO DA TRANSMISSÃO"]);
  await recalculateMaintenanceCycles(d1,{equipmentId:pcId,force:true,notify:false});
  assert.equal(database.prepare("SELECT last_hours FROM maintenance_plans WHERE equipment_id=? AND maintenance_type_id=?").get(pcId,maintenanceTypeId(database,"TROCA DE ÓLEO DO MOTOR")).last_hours,null);
  addImported(database,{prefix:pcPrefix,service:"Troca de óleo do motor",reading:7100,unit:"HOURS",date:"2026-04-01"});
  addImported(database,{prefix:pcPrefix,service:"Troca de óleo do motor",reading:7000,unit:"HOURS",date:"2026-07-01"});
  addImported(database,{prefix:pcPrefix,service:"Troca de óleo da transmissão",reading:6000,unit:"HOURS",date:"2026-07-02"});
  await recalculateMaintenanceCycles(d1,{equipmentId:pcId,force:true,notify:false});
  const pcPlans=database.prepare(`SELECT t.name,p.last_hours,p.next_hours FROM maintenance_plans p
    INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id WHERE p.equipment_id=? AND p.active=1 ORDER BY t.name`).all(pcId);
  assert.deepEqual(pcPlans.map((plan)=>[plan.name,plan.last_hours,plan.next_hours]),[
    ["TROCA DE ÓLEO DA TRANSMISSÃO",6000,8000],
    ["TROCA DE ÓLEO DO MOTOR",7000,7250],
  ],"o registro mais recente pela data deve vencer uma leitura maior, porém mais antiga");
  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM imported_maintenance_history WHERE equipment_id=? AND maintenance_type_id IS NOT NULL").get(pcId).total,3);
  database.close();
});

test("histórico com data e leitura válidas deixa de ser ignorado quando a categoria não tem intervalo padrão cadastrado",async()=>{
  const database=migratedDatabase();const d1=new LocalD1(database);
  seedMaintenanceTypes(database,["TROCA DE ÓLEO DO MOTOR","TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO"]);
  // Categoria "TE" propositalmente SEM nenhuma linha em maintenance_interval_configs —
  // reproduz o cenário relatado (histórico com data e leitura válidas, mas o
  // Plano de Manutenção continuava tratando como se não existisse histórico).
  const tePrefix="TE-REG-01";
  const teId=addEquipment(database,{prefix:tePrefix,type:"Trator",controlType:"HOURS",currentHours:15000,currentKm:0});
  enableTypes(database,teId,["TROCA DE ÓLEO DO MOTOR","TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO"]);
  addImported(database,{prefix:tePrefix,service:"Troca de óleo do motor",reading:12433,unit:"HOURS",date:"2024-05-16"});
  addImported(database,{prefix:tePrefix,service:"Troca de óleo do diferencial dianteiro",reading:12433,unit:"HOURS",date:"2024-05-16"});
  await recalculateMaintenanceCycles(d1,{equipmentId:teId,force:true,notify:false});

  const tePlans=database.prepare(`SELECT t.name,p.interval_hours,p.last_hours,p.next_hours FROM maintenance_plans p
    INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id WHERE p.equipment_id=? AND p.active=1 ORDER BY t.name`).all(teId);
  assert.deepEqual(tePlans.map((plan)=>[plan.name,plan.interval_hours,plan.last_hours,plan.next_hours]),[
    ["TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO",null,12433,null],
    ["TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO",null,null,null],
    ["TROCA DE ÓLEO DO MOTOR",null,12433,null],
  ],"sem intervalo configurado o plano fica 'Sem plano', mas a última leitura válida já aparece — deixa de estar invisível");

  // Quando o administrador configura o intervalo manualmente (equivalente a
  // salvar o Plano de Manutenção pela ficha), a próxima troca passa a ser
  // calculada a partir da ÚLTIMA TROCA REAL, nunca da leitura atual.
  const now=new Date().toISOString();
  database.prepare(`UPDATE maintenance_plans SET interval_hours=500,updated_at=? WHERE equipment_id=? AND maintenance_type_id=?`)
    .run(now,teId,maintenanceTypeId(database,"TROCA DE ÓLEO DO MOTOR"));
  await recalculateMaintenanceCycles(d1,{equipmentId:teId,force:true,notify:false});
  const motorPlan={...database.prepare(`SELECT interval_hours,last_hours,next_hours FROM maintenance_plans WHERE equipment_id=? AND maintenance_type_id=?`)
    .get(teId,maintenanceTypeId(database,"TROCA DE ÓLEO DO MOTOR"))};
  assert.deepEqual(motorPlan,{interval_hours:500,last_hours:12433,next_hours:12933},"próxima troca = última troca real (12433) + intervalo, nunca leitura atual (15000) + intervalo");
  database.close();
});

test("unidade do plano segue o control_type real do equipamento, mesmo com a configuração padrão cadastrada na unidade errada",async()=>{
  const database=migratedDatabase();const d1=new LocalD1(database);
  seedMaintenanceTypes(database,["TROCA DE ÓLEO DO MOTOR"]);
  // Configuração de categoria propositalmente cadastrada em HORAS, mas o
  // equipamento real dessa categoria é controlado por KM — reproduz o caso
  // relatado de unidade incompatível entre horas e quilômetros.
  seedIntervalConfigs(database,[{category:"CA",unit:"HOURS",interval:250,names:["TROCA DE ÓLEO DO MOTOR"]}]);
  const caPrefix="CA-REG-01";
  const caId=addEquipment(database,{prefix:caPrefix,type:"Carro",controlType:"KM",currentHours:0,currentKm:220000});
  enableTypes(database,caId,["TROCA DE ÓLEO DO MOTOR"]);
  addImported(database,{prefix:caPrefix,service:"Troca de óleo do motor",reading:215225,unit:"KM",date:"2025-02-04"});
  await recalculateMaintenanceCycles(d1,{equipmentId:caId,force:true,notify:false});

  const plan={...database.prepare(`SELECT trigger_mode,interval_hours,interval_km,last_hours,last_km,next_km FROM maintenance_plans WHERE equipment_id=? AND maintenance_type_id=?`)
    .get(caId,maintenanceTypeId(database,"TROCA DE ÓLEO DO MOTOR"))};
  assert.deepEqual(plan,{trigger_mode:"KM",interval_hours:null,interval_km:null,last_hours:null,last_km:215225,next_km:null},
    "a leitura em KM não pode ficar invisível só porque a configuração padrão da categoria está em horas; sem um intervalo em KM válido o plano fica 'Sem plano', nunca com um número na unidade errada");
  database.close();
});
