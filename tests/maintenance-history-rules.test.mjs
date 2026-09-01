import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalEquipmentPrefix,
  canonicalMaintenanceService,
  chooseLatestHistoryCandidate,
  maintenancePlanUnit,
  reconcileEquipmentMeasurement,
} from "../lib/maintenance-history.ts";
import { calculatePlanState } from "../lib/maintenance-engine.ts";
import { fleetDayWindow, fleetOccurrenceId } from "../lib/fleet-status.ts";

test("reconhece variações conhecidas sem confundir atualização de leitura",()=>{
  assert.equal(canonicalEquipmentPrefix(" cm – 27 "),"CM-27");
  assert.equal(canonicalMaintenanceService("Troca de óleo do MOTOR"),"MOTOR");
  assert.equal(canonicalMaintenanceService("troca-de-óleo da caixa de marchas"),"CAIXA DE MARCHA");
  assert.equal(canonicalMaintenanceService("Diferencial dianteiro"),"DIFERENCIAL DIANTEIRO");
  assert.equal(canonicalMaintenanceService("TRANSMISSÃO"),"TRANSMISSAO");
  assert.notEqual(canonicalMaintenanceService("ATUALIZAÇÃO DE KM"),"MOTOR");
});

test("usa a data da realização antes da ordem de inserção ou da leitura",()=>{
  const base={equipmentId:27,maintenanceTypeId:1,unit:"KM",sourcePriority:1};
  const olderWithHigherReading={...base,performedAt:"2026-06-20",reading:124673};
  const newerWithLowerReading={...base,performedAt:"2026-07-11",reading:124500};
  assert.deepEqual(chooseLatestHistoryCandidate(olderWithHigherReading,newerWithLowerReading),newerWithLowerReading);
});

test("quando nenhum registro possui data, usa a maior leitura válida",()=>{
  const base={equipmentId:27,maintenanceTypeId:1,unit:"KM",sourcePriority:1,performedAt:null};
  const previous={...base,reading:95123};
  const importedWithoutDate={...base,reading:124673};
  assert.deepEqual(chooseLatestHistoryCandidate(previous,importedWithoutDate),importedWithoutDate);
});

test("o cadastro em KM corrige um Plano antigo salvo em Horas",()=>{
  const measurement=reconcileEquipmentMeasurement({prefix:" CM - 27 ",type:"Caminhão",controlType:"HOURS",currentHours:133665,currentKm:132718,previousControlType:"HOURS"});
  assert.deepEqual({controlType:measurement.controlType,currentHours:measurement.currentHours,currentKm:measurement.currentKm},{controlType:"KM",currentHours:0,currentKm:133665});
  const unit=maintenancePlanUnit("KM","KM","HOURS",12000,null);
  assert.equal(unit,"KM");
  const state=calculatePlanState({id:27,triggerMode:unit,intervalHours:null,intervalKm:12000,lastHours:null,lastKm:124673,nextHours:null,nextKm:136673},0,133665,{
    alertaHorasAmareloFim:100,alertaHorasLaranjaFim:50,alertaKmAmareloFim:2000,alertaKmLaranjaFim:1000,urgencyPercent:20,
  });
  assert.equal(state.lastValue,124673);
  assert.equal(state.nextValue,136673);
  assert.equal(state.remaining,3008);
  assert.equal(state.unit,"KM");
});

test("o CM-27 calcula os quatro saldos esperados sem converter KM em horas",()=>{
  const currentKm=133665;
  const cases=[
    [94386,40000,134386,721],
    [125147,30000,155147,21482],
    [125147,30000,155147,21482],
    [124673,12000,136673,3008],
  ];
  for(const [lastKm,intervalKm,nextKm,remaining] of cases){
    const state=calculatePlanState({id:27,triggerMode:"KM",intervalHours:null,intervalKm,lastHours:null,lastKm,nextHours:null,nextKm},0,currentKm,{
      alertaHorasAmareloFim:100,alertaHorasLaranjaFim:50,alertaKmAmareloFim:2000,alertaKmLaranjaFim:1000,urgencyPercent:20,
    });
    assert.equal(state.lastValue,lastKm);assert.equal(state.nextValue,nextKm);assert.equal(state.remaining,remaining);assert.equal(state.unit,"KM");
  }
});

test("o relatório diário usa o dia completo no fuso de Fortaleza",()=>{
  const window=fleetDayWindow("2026-08-26");
  assert.equal(window.start,"2026-08-26T03:00:00.000Z");
  assert.equal(window.end,"2026-08-27T03:00:00.000Z");
});

test("cada parada recebe um identificador próprio e rastreável",()=>{
  assert.match(fleetOccurrenceId("2026-08-26T11:10:00.000Z"),/^OC-20260826-[A-F0-9-]{8}$/);
});
