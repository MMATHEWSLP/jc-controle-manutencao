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

function migratedDatabase(){
  const database=new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for(const file of readdirSync(join(projectRoot,"drizzle")).filter((name)=>name.endsWith(".sql")).sort()){
    database.exec(readFileSync(join(projectRoot,"drizzle",file),"utf8").replaceAll("--> statement-breakpoint",""));
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

test("reconcilia e calcula o Plano independentemente da ordem entre Histórico e cadastro",async()=>{
  const database=migratedDatabase();const d1=new LocalD1(database);
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
