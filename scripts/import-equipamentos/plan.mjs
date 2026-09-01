// Lógica pura de classificação/planejamento da importação — não toca no
// banco. Recebe as linhas já normalizadas (parse.mjs) e um retrato do que já
// existe no banco (montado por importar-equipamentos.mjs a partir de
// consultas reais) e devolve, para cada linha, uma decisão determinística.
// Mantida separada de qualquer I/O para poder ser testada sem banco de dados.

const TRAILER_KEYWORDS = ["JULIETA", "REBOQUE", "CARRETA", "PRANCHA", "SEMI REBOQUE", "SEMIRREBOQUE", "TANQUE"];

export function looksLikeTrailer(description) {
  const upper = String(description ?? "").toUpperCase();
  return TRAILER_KEYWORDS.some((keyword) => upper.includes(keyword));
}

function mostCommon(counts) {
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// Decide o "type" (categoria descritiva livre, ex.: "Pá Carregadeira") e o
// `oilChangeEnabled`/`identificationType` reaproveitando o que já está
// cadastrado para a mesma categoria de prefixo (CA, CM, JL, ...) sempre que
// existir consenso. Só cai para uma regra técnica objetiva (trailer sem
// motor) quando não há nenhuma referência no banco.
export function inferEquipmentDefaults(row, categoryStats) {
  const stats = categoryStats?.get(row.category) ?? null;
  const notes = [];

  let type = row.description;
  let typeSource = "descrição da planilha (categoria nova para o sistema)";
  if (stats?.typeCounts?.size) {
    const common = mostCommon(stats.typeCounts);
    if (common) {
      type = common;
      typeSource = `reaproveitado de equipamento existente da categoria ${row.category}`;
    }
  }

  let oilChangeEnabled;
  let oilSource;
  if (stats && (stats.oilEnabledCounts.true > 0) !== (stats.oilEnabledCounts.false > 0)) {
    oilChangeEnabled = stats.oilEnabledCounts.true > 0;
    oilSource = `reaproveitado da configuração já usada na categoria ${row.category}`;
  } else if (stats && stats.oilEnabledCounts.true > 0 && stats.oilEnabledCounts.false > 0) {
    oilChangeEnabled = !looksLikeTrailer(row.description);
    oilSource = `categoria ${row.category} tem configuração mista no banco — usada regra técnica (reboque sem motor não faz troca de óleo)`;
    notes.push(`Categoria ${row.category} tem equipamentos com "faz troca de óleo" divergente — revisar.`);
  } else {
    oilChangeEnabled = !looksLikeTrailer(row.description);
    oilSource = "sem equipamento existente nessa categoria — usada regra técnica (reboque/prancha/carreta sem motor não faz troca de óleo)";
  }

  let identificationType;
  let identificationSource;
  if (stats?.identificationTypeCounts && (stats.identificationTypeCounts.CHASSIS > 0) !== (stats.identificationTypeCounts.SERIAL_NUMBER > 0)) {
    identificationType = stats.identificationTypeCounts.CHASSIS > 0 ? "CHASSIS" : "SERIAL_NUMBER";
    identificationSource = `reaproveitado da categoria ${row.category}`;
  } else {
    identificationType = row.plate ? "CHASSIS" : "SERIAL_NUMBER";
    identificationSource = "sem referência clara — inferido por ter ou não placa (veículo rodoviário usa chassi, máquina usa número de série)";
  }

  return { type, typeSource, oilChangeEnabled, oilSource, identificationType, identificationSource, notes };
}

// Determina, para a categoria da linha, se já existe um template de plano
// de manutenção configurado (maintenance_interval_configs). Esse é o único
// mecanismo de "plano de referência" que este sistema realmente possui: um
// template por categoria (não por equipamento específico), então reaproveitar
// o template da categoria cobre as prioridades 1-3 do pedido nesta base.
export function resolvePlanTemplate(row, categoryStats) {
  const stats = categoryStats?.get(row.category);
  if (!row.category) return { status: "PENDENTE_CONFIGURACAO", reason: "Prefixo sem categoria (não segue o padrão LETRAS-NUMERO)" };
  if (!stats?.hasTemplate) return { status: "PENDENTE_CONFIGURACAO", reason: `Nenhum equipamento da categoria ${row.category} possui plano configurado ainda` };
  return { status: "TEMPLATE_CATEGORIA", reason: `Reaproveitado o template já configurado para a categoria ${row.category}`, maintenanceTypeNames: stats.templateMaintenanceTypeNames };
}

// Classifica cada linha como JA_EXISTENTE, CONFLITO ou NOVO, cruzando
// prefixo/chassi/série/placa normalizados com o que já está no banco e com
// as próprias duplicidades internas do arquivo.
export function classifyRow(row, existing) {
  const byPrefix = existing.equipmentByPrefixKey.get(row.prefixKey);
  if (byPrefix) {
    return { action: "JA_EXISTENTE", existingEquipmentId: byPrefix.id, reason: `Prefixo ${row.prefixRaw} já cadastrado (id ${byPrefix.id})` };
  }

  const conflicts = [];
  if (row.serialKey) {
    const hit = existing.allChassisSerialKeys.get(row.serialKey);
    if (hit) conflicts.push(`Chassi/série "${row.serialRaw}" já pertence a ${hit.prefix} (campo ${hit.field})`);
  }
  if (row.plateKey) {
    const hit = existing.allPlateKeys.get(row.plateKey);
    if (hit) conflicts.push(`Placa "${row.plate}" já pertence a ${hit.prefix}`);
  }
  if (conflicts.length) return { action: "CONFLITO", reason: conflicts.join("; ") };

  return { action: "NOVO", reason: "Prefixo, chassi/série e placa não encontrados no cadastro atual" };
}

// Monta o plano completo de importação: uma decisão por linha do arquivo,
// mais os totais exigidos no relatório final.
export function buildImportPlan(rows, existing, crossRowConflictPrefixKeys = new Set()) {
  const decisions = rows.map((row) => {
    if (crossRowConflictPrefixKeys.has(row.prefixKey) || crossRowConflictPrefixKeys.has(row.serialKey) || (row.plateKey && crossRowConflictPrefixKeys.has(row.plateKey))) {
      return { row, action: "CONFLITO", reason: "Conflito com outra linha do próprio arquivo de origem (ver seção de duplicidades internas)" };
    }
    const classification = classifyRow(row, existing);
    if (classification.action !== "NOVO") return { row, ...classification };

    const defaults = inferEquipmentDefaults(row, existing.categoryStats);
    const plan = resolvePlanTemplate(row, existing.categoryStats);
    return {
      row,
      action: "NOVO",
      reason: classification.reason,
      insert: {
        type: defaults.type,
        typeSource: defaults.typeSource,
        oilChangeEnabled: defaults.oilChangeEnabled,
        oilSource: defaults.oilSource,
        identificationType: defaults.identificationType,
        identificationSource: defaults.identificationSource,
        notes: [...defaults.notes, ...row.alerts, defaults.oilChangeEnabled ? plan.reason : "Troca de óleo desabilitada — plano não aplicável"].join(" | ") || null,
        planStatus: defaults.oilChangeEnabled ? plan.status : "NAO_APLICAVEL",
        planReason: plan.reason,
        planMaintenanceTypeNames: plan.maintenanceTypeNames ?? [],
      },
    };
  });

  const totals = decisions.reduce(
    (acc, decision) => {
      acc.total += 1;
      acc[decision.action] = (acc[decision.action] ?? 0) + 1;
      if (decision.action === "NOVO" && decision.insert.oilChangeEnabled) {
        if (decision.insert.planStatus === "TEMPLATE_CATEGORIA") acc.planTemplate += 1;
        else if (decision.insert.planStatus === "PENDENTE_CONFIGURACAO") acc.planPendente += 1;
      }
      return acc;
    },
    { total: 0, JA_EXISTENTE: 0, NOVO: 0, CONFLITO: 0, planTemplate: 0, planPendente: 0 },
  );

  return { decisions, totals };
}
