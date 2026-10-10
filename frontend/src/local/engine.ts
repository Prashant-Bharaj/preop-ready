// Deterministic pre-procedure checks — a 1:1 port of backend/app/rules/engine.py.
// Clinical cutoffs are read from the requirements and thresholds documents.
// This module only applies those documents and the fixed category rules.
// Keep it pure: no storage, no clock (the caller passes `asOf`).

import type { RequirementsDoc, ThresholdsDoc, LabThreshold } from "../api";
import { addDays, daysBetween, fmt, type ISODate } from "./dates";

export const CRITICAL = "CRITICAL";
export const WARNING = "WARNING";

export const MISSING = "MISSING";
export const OUTDATED = "OUTDATED";
export const ABNORMAL = "ABNORMAL";
export const IMPLAUSIBLE = "IMPLAUSIBLE";
export const INCONSISTENT = "INCONSISTENT";
export const CLEARANCE = "CLEARANCE";

export const ROLE_ANESTHESIA = "Anästhesie";
export const ROLE_PHYSICIAN = "Arzt";
export const ROLE_COORDINATION = "Pflege/Koordination";

export interface Observation {
  id: string;
  patientId: string;
  code: string;
  value: number | null;
  unit: string;
  effectiveDate: ISODate;
  source: string;
  documentPatientId?: string | null;
}

export interface DiagnosticReport {
  id: string;
  patientId: string;
  reportType: string;
  reportDate: ISODate | null;
  conclusionText: string;
  source: string;
  documentPatientId?: string | null;
  evidence?: string | null;
}

export interface AnesthesiaClearance {
  id: string;
  patientId: string;
  status: string;
  clearanceDate: ISODate | null;
  asaClass: string | null;
  conditions: string[];
  anesthetist: string | null;
  source: string;
}

export interface Medication {
  id: string;
  patientId: string;
  name: string;
  drugClass: string;
  status: string;
  pausedSince: ISODate | null;
  source: string;
}

export interface EngineFinding {
  category: string;
  severity: string;
  item: string;
  messageDe: string;
  messageEn: string;
  sourceRef: string;
  role: string;
}

export type Readiness = "GREEN" | "YELLOW" | "RED";

export function overallStatus(findings: Pick<EngineFinding, "severity" | "category">[]): Readiness {
  // Severity drives readiness: MISSING+WARNING (e.g. post-procedure items
  // not yet due) stays yellow; MISSING+CRITICAL remains red.
  if (findings.some((f) => f.severity === CRITICAL)) return "RED";
  if (findings.some((f) => f.severity === WARNING || f.category === OUTDATED)) return "YELLOW";
  return "GREEN";
}

export function itemState(
  item: string,
  findings: Pick<EngineFinding, "item" | "severity" | "category">[],
): "complete" | "missing" | "outdated" | "warning" | "critical" {
  const related = findings.filter((f) => f.item === item);
  if (related.some((f) => f.category === MISSING)) return "missing";
  if (related.some((f) => f.severity === CRITICAL)) return "critical";
  if (related.some((f) => f.category === OUTDATED)) return "outdated";
  if (related.length) return "warning";
  return "complete";
}

export interface EvaluateInput {
  patientId: string;
  procedureType: string;
  plannedDate: ISODate;
  observations: Observation[];
  reports: DiagnosticReport[];
  clearance: AnesthesiaClearance | null;
  medications: Medication[];
  requirementsDoc: RequirementsDoc;
  thresholdsDoc: ThresholdsDoc;
  asOf?: ISODate | null;
}

export function evaluateCase(input: EvaluateInput): EngineFinding[] {
  const { patientId, procedureType, plannedDate, requirementsDoc, thresholdsDoc } = input;
  const procedureRules = (requirementsDoc.procedures || {})[procedureType];
  if (!procedureRules || procedureRules.length === 0) {
    const label = procedureType || "procedure";
    return [
      finding({
        category: INCONSISTENT,
        severity: WARNING,
        item: "config.requirements",
        sourceRef: "config:requirements",
        de: `Keine Anforderungen für ${label} konfiguriert.`,
        en: `No requirements are configured for ${label}.`,
      }),
    ];
  }

  const labels = requirementsDoc.labels || {};
  const labsCfg = thresholdsDoc.labs || {};
  const findings: EngineFinding[] = [];
  const checkDay = input.asOf || plannedDate;

  for (const rule of procedureRules) {
    const item = String(rule.item || "");
    // Mirrors Python's bool(rule.get("required", True)): absent -> true, null -> false.
    const required = rule.required === undefined ? true : Boolean(rule.required);
    const maxAge = rule.maxAgeDays ?? null;
    const mustMention = rule.mustMention ?? null;
    const timing = String(rule.timing || "pre").toLowerCase();
    const offsetDays = rule.offsetDays ?? null;
    const suffix = item.split(".").slice(1).join(".");
    if (item.startsWith("lab.")) {
      findings.push(
        ...checkLab({
          code: suffix,
          item,
          required,
          maxAge,
          patientId,
          procedureType,
          plannedDate,
          observations: input.observations,
          spec: labsCfg[suffix] || null,
        }),
      );
    } else if (item.startsWith("report.")) {
      findings.push(
        ...checkReport({
          reportType: suffix,
          item,
          required,
          maxAge,
          mustMention,
          timing,
          offsetDays,
          patientId,
          procedureType,
          plannedDate,
          asOf: checkDay,
          reports: input.reports,
          label: labels[item] || null,
        }),
      );
    } else if (item.startsWith("clearance.")) {
      findings.push(
        ...checkClearance({
          item,
          required,
          maxAge,
          procedureType,
          plannedDate,
          clearance: input.clearance,
          label: labels[item] || null,
        }),
      );
    }
  }

  findings.push(
    ...checkMedications({
      patientId,
      procedureType,
      plannedDate,
      observations: input.observations,
      medications: input.medications,
      labsCfg,
      consistency: thresholdsDoc.consistency || { pauseRequiredClasses: [], metforminEgfrMin: null, egfrCode: "egfr" },
    }),
  );
  return dedupe(findings);
}

// ---------------------------------------------------------------- labs

function checkLab(a: {
  code: string;
  item: string;
  required: boolean;
  maxAge: number | null;
  patientId: string;
  procedureType: string;
  plannedDate: ISODate;
  observations: Observation[];
  spec: LabThreshold | null;
}): EngineFinding[] {
  const [labelDe, labelEn] = labLabels(a.code, a.spec);
  const rows = a.observations.filter((o) => o.patientId === a.patientId && o.code === a.code);
  const findings: EngineFinding[] = [];
  if (!rows.length) {
    if (a.required) {
      findings.push(
        finding({
          category: MISSING,
          severity: CRITICAL,
          item: a.item,
          sourceRef: a.item,
          de: `${labelDe} fehlt – bitte Labor vor ${a.procedureType} am ${fmt(a.plannedDate)} abnehmen.`,
          en: `${labelEn} is missing – please draw blood before ${a.procedureType} on ${fmt(a.plannedDate)}.`,
        }),
      );
    }
    return findings;
  }

  for (const row of rows) {
    if (row.effectiveDate > a.plannedDate) {
      findings.push(
        finding({
          category: IMPLAUSIBLE,
          severity: CRITICAL,
          item: a.item,
          sourceRef: row.id,
          de: `${labelDe} ist auf den ${fmt(row.effectiveDate)} datiert, nach dem geplanten ${a.procedureType} am ${fmt(a.plannedDate)}.`,
          en: `${labelEn} is dated ${fmt(row.effectiveDate)}, after the planned ${a.procedureType} on ${fmt(a.plannedDate)}.`,
        }),
      );
    }
  }

  const usable = rows.filter((r) => r.effectiveDate <= a.plannedDate);
  if (!usable.length) return findings;

  findings.push(...duplicateFindings(a.item, labelDe, labelEn, usable));
  const sortedDays = usable.map((r) => r.effectiveDate).sort();
  const latestDay = sortedDays[sortedDays.length - 1]!;
  const latestRows = usable.filter((r) => r.effectiveDate === latestDay);
  for (const row of latestRows) {
    findings.push(...valueFindings(row, a.item, labelDe, labelEn, a.spec));
  }

  const age = daysBetween(latestDay, a.plannedDate);
  if (a.maxAge !== null && age > Math.trunc(a.maxAge)) {
    const max = Math.trunc(a.maxAge);
    findings.push(
      finding({
        category: OUTDATED,
        severity: WARNING,
        item: a.item,
        sourceRef: latestRows[0].id,
        de: `${labelDe}: veraltet (${age} Tage, erlaubt ${max}) – bitte vor ${a.procedureType} am ${fmt(a.plannedDate)} wiederholen.`,
        en: `${labelEn} is outdated (${age} days, allowed ${max}) – please repeat before ${a.procedureType} on ${fmt(a.plannedDate)}.`,
      }),
    );
  }
  return findings;
}

function valueFindings(
  row: Observation,
  item: string,
  labelDe: string,
  labelEn: string,
  spec: LabThreshold | null,
): EngineFinding[] {
  const expected = spec?.unit;
  if (expected && !unitsMatch(row.unit, String(expected))) {
    return [
      finding({
        category: IMPLAUSIBLE,
        severity: WARNING,
        item,
        sourceRef: row.id,
        de: `${labelDe}: Einheit „${row.unit}“ passt nicht zur erwarteten Einheit „${expected}“.`,
        en: `${labelEn}: unit “${row.unit}” does not match the expected unit “${expected}”.`,
      }),
    ];
  }
  if (row.value === null || row.value === undefined) {
    return [
      finding({
        category: IMPLAUSIBLE,
        severity: WARNING,
        item,
        sourceRef: row.id,
        de: `${labelDe}: kein numerischer Wert dokumentiert.`,
        en: `${labelEn}: no numeric value documented.`,
      }),
    ];
  }
  const value = row.value;
  const lowB = spec?.implausibleLow ?? null;
  const highB = spec?.implausibleHigh ?? null;
  if ((lowB !== null && value < lowB) || (highB !== null && value > highB)) {
    return [
      finding({
        category: IMPLAUSIBLE,
        severity: WARNING,
        item,
        sourceRef: row.id,
        de: `${labelDe} ${num(value)} ${row.unit} ist physiologisch nicht plausibel.`,
        en: `${labelEn} ${num(value)} ${row.unit} is not physiologically plausible.`,
      }),
    ];
  }
  const critLow = spec?.criticalLow ?? null;
  const critHigh = spec?.criticalHigh ?? null;
  if (critLow !== null && value < critLow) return [abnormal(row, item, labelDe, labelEn, CRITICAL, critLow, "low")];
  if (critHigh !== null && value > critHigh) return [abnormal(row, item, labelDe, labelEn, CRITICAL, critHigh, "high")];
  const low = spec?.low ?? null;
  const high = spec?.high ?? null;
  if (low !== null && value < low) return [abnormal(row, item, labelDe, labelEn, WARNING, low, "low")];
  if (high !== null && value > high) return [abnormal(row, item, labelDe, labelEn, WARNING, high, "high")];
  return [];
}

function abnormal(
  row: Observation,
  item: string,
  labelDe: string,
  labelEn: string,
  severity: string,
  bound: number,
  side: "low" | "high",
): EngineFinding {
  const kindDe = severity === CRITICAL ? "kritisch" : "auffällig";
  const kindEn = severity === CRITICAL ? "critical" : "abnormal";
  const dirDe = side === "low" ? "unter" : "über";
  const dirEn = side === "low" ? "below" : "above";
  return finding({
    category: ABNORMAL,
    severity,
    item,
    sourceRef: row.id,
    de: `${labelDe} ${num(row.value!)} ${row.unit} ist ${kindDe} (${dirDe} ${num(bound)}).`,
    en: `${labelEn} ${num(row.value!)} ${row.unit} is ${kindEn} (${dirEn} ${num(bound)}).`,
  });
}

function duplicateFindings(item: string, labelDe: string, labelEn: string, rows: Observation[]): EngineFinding[] {
  const findings: EngineFinding[] = [];
  const byDay = new Map<string, Observation[]>();
  for (const row of rows) {
    const group = byDay.get(row.effectiveDate) || [];
    group.push(row);
    byDay.set(row.effectiveDate, group);
  }
  for (const [day, group] of byDay) {
    // toFixed rounds the exact binary value, like Python's round(x, 4).
    const values = new Set(group.map((r) => (r.value === null ? null : Number(r.value.toFixed(4)))));
    if (group.length > 1 && values.size > 1) {
      // Python lists a set here (unspecified order); we sort for a stable message.
      const ordered = [...values].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
      const listed = ordered.map((v) => (v === null ? "–" : num(v))).join(", ");
      findings.push(
        finding({
          category: IMPLAUSIBLE,
          severity: WARNING,
          item,
          sourceRef: group[0].id,
          de: `${labelDe}: widersprüchliche Werte am ${fmt(day)} (${listed}).`,
          en: `${labelEn}: conflicting values on ${fmt(day)} (${listed}).`,
        }),
      );
    }
  }
  return findings;
}

// ------------------------------------------------------------- reports

function checkReport(a: {
  reportType: string;
  item: string;
  required: boolean;
  maxAge: number | null;
  mustMention: string | null;
  timing: string;
  offsetDays: number | null;
  patientId: string;
  procedureType: string;
  plannedDate: ISODate;
  asOf: ISODate;
  reports: DiagnosticReport[];
  label: { de: string; en: string } | null;
}): EngineFinding[] {
  const [labelDe, labelEn] = pair(a.label, a.reportType);
  const rows = a.reports.filter((r) => r.patientId === a.patientId && r.reportType === a.reportType);
  if (a.timing === "post") {
    return checkReportPost({
      item: a.item,
      required: a.required,
      mustMention: a.mustMention,
      offsetDays: a.offsetDays === null ? 1 : Math.trunc(a.offsetDays),
      procedureType: a.procedureType,
      plannedDate: a.plannedDate,
      asOf: a.asOf,
      rows,
      labelDe,
      labelEn,
    });
  }

  const findings: EngineFinding[] = [];
  if (!rows.length) {
    if (a.required) {
      let de: string;
      let en: string;
      if (a.reportType === "AGREEMENT") {
        de = `${labelDe} fehlt – der Patient muss vor ${a.procedureType} am ${fmt(a.plannedDate)} unterschreiben.`;
        en = `${labelEn} is missing – the patient must sign it before ${a.procedureType} on ${fmt(a.plannedDate)}.`;
      } else {
        de = `${labelDe} fehlt – bitte vor ${a.procedureType} am ${fmt(a.plannedDate)} anmelden.`;
        en = `${labelEn} is missing – please schedule it before ${a.procedureType} on ${fmt(a.plannedDate)}.`;
      }
      findings.push(finding({ category: MISSING, severity: CRITICAL, item: a.item, sourceRef: a.item, de, en }));
    }
    return findings;
  }

  for (const row of rows) {
    if (row.reportDate === null) {
      findings.push(
        finding({
          category: IMPLAUSIBLE,
          severity: WARNING,
          item: a.item,
          sourceRef: row.id,
          de: `${labelDe}: kein Befunddatum dokumentiert.`,
          en: `${labelEn}: no report date documented.`,
        }),
      );
    } else if (row.reportDate > a.plannedDate) {
      findings.push(
        finding({
          category: IMPLAUSIBLE,
          severity: CRITICAL,
          item: a.item,
          sourceRef: row.id,
          de: `${labelDe} ist auf den ${fmt(row.reportDate)} datiert, nach dem geplanten ${a.procedureType} am ${fmt(a.plannedDate)}.`,
          en: `${labelEn} is dated ${fmt(row.reportDate)}, after the planned ${a.procedureType} on ${fmt(a.plannedDate)}.`,
        }),
      );
    }
  }

  const usable = rows.filter((r) => r.reportDate !== null && r.reportDate <= a.plannedDate);
  if (!usable.length) return findings;

  const latest = latestReport(usable);
  if (a.maxAge !== null && latest.reportDate !== null) {
    const age = daysBetween(latest.reportDate, a.plannedDate);
    const max = Math.trunc(a.maxAge);
    if (age > max) {
      findings.push(
        finding({
          category: OUTDATED,
          severity: WARNING,
          item: a.item,
          sourceRef: latest.id,
          de: `${labelDe}: veraltet (${age} Tage, erlaubt ${max}) – bitte vor ${a.procedureType} am ${fmt(a.plannedDate)} wiederholen.`,
          en: `${labelEn} is outdated (${age} days, allowed ${max}) – please repeat before ${a.procedureType} on ${fmt(a.plannedDate)}.`,
        }),
      );
    }
  }
  findings.push(...mustMentionFindings(a.mustMention, latest, a.item, labelDe, labelEn, a.procedureType, a.plannedDate));
  return findings;
}

function checkReportPost(a: {
  item: string;
  required: boolean;
  mustMention: string | null;
  offsetDays: number;
  procedureType: string;
  plannedDate: ISODate;
  asOf: ISODate;
  rows: DiagnosticReport[];
  labelDe: string;
  labelEn: string;
}): EngineFinding[] {
  const target = addDays(a.plannedDate, a.offsetDays);
  const findings: EngineFinding[] = [];

  for (const row of a.rows) {
    if (row.reportDate === null) {
      findings.push(
        finding({
          category: IMPLAUSIBLE,
          severity: WARNING,
          item: a.item,
          sourceRef: row.id,
          de: `${a.labelDe}: kein Befunddatum dokumentiert.`,
          en: `${a.labelEn}: no report date documented.`,
        }),
      );
    } else if (row.reportDate < a.plannedDate) {
      findings.push(
        finding({
          category: INCONSISTENT,
          severity: WARNING,
          item: a.item,
          sourceRef: row.id,
          de: `${a.labelDe} ist auf den ${fmt(row.reportDate)} datiert – erwartet am ${fmt(target)} (nach ${a.procedureType}).`,
          en: `${a.labelEn} is dated ${fmt(row.reportDate)} – expected on ${fmt(target)} (after ${a.procedureType}).`,
        }),
      );
    }
  }

  const usable = a.rows.filter((r) => r.reportDate !== null && r.reportDate >= target);
  if (!usable.length) {
    if (!a.required) return findings;
    const pending = a.asOf < target;
    const severity = pending ? WARNING : CRITICAL;
    const whenDe = a.offsetDays === 1 ? "Tag nach dem Eingriff" : `${a.offsetDays} Tage nach dem Eingriff`;
    const whenEn = a.offsetDays === 1 ? "day after the procedure" : `${a.offsetDays} days after the procedure`;
    let de = `${a.labelDe} fehlt – geplant für den ${fmt(target)} (${whenDe}, ${a.procedureType} am ${fmt(a.plannedDate)}).`;
    let en = `${a.labelEn} is missing – scheduled for ${fmt(target)} (${whenEn}, ${a.procedureType} on ${fmt(a.plannedDate)}).`;
    if (!pending) {
      de = `${a.labelDe} fehlt – bitte am ${fmt(target)} nach ${a.procedureType} nachholen.`;
      en = `${a.labelEn} is missing – please obtain it on ${fmt(target)} after ${a.procedureType}.`;
    }
    findings.push(finding({ category: MISSING, severity, item: a.item, sourceRef: a.item, de, en }));
    return findings;
  }

  const latest = latestReport(usable);
  findings.push(...mustMentionFindings(a.mustMention, latest, a.item, a.labelDe, a.labelEn, a.procedureType, a.plannedDate));
  return findings;
}

function latestReport(rows: DiagnosticReport[]): DiagnosticReport {
  // Python's max() keeps the first of equal keys.
  let best = rows[0];
  for (const row of rows.slice(1)) {
    if ((row.reportDate || "") > (best.reportDate || "")) best = row;
  }
  return best;
}

function mustMentionFindings(
  mustMention: string | null,
  latest: DiagnosticReport,
  item: string,
  labelDe: string,
  labelEn: string,
  procedureType: string,
  plannedDate: ISODate,
): EngineFinding[] {
  if (!mustMention) return [];
  const text = latest.conclusionText || "";
  if (text.toLowerCase().includes(String(mustMention).toLowerCase())) return [];
  return [
    finding({
      category: MISSING,
      severity: CRITICAL,
      item,
      sourceRef: latest.id,
      de: `${mustMention}-Hinweis fehlt in der ${labelDe} – bitte vor ${procedureType} am ${fmt(plannedDate)} ergänzen.`,
      en: `${mustMention} is not mentioned in the ${labelEn} – please add it before ${procedureType} on ${fmt(plannedDate)}.`,
    }),
  ];
}

// ----------------------------------------------------------- clearance

function checkClearance(a: {
  item: string;
  required: boolean;
  maxAge: number | null;
  procedureType: string;
  plannedDate: ISODate;
  clearance: AnesthesiaClearance | null;
  label: { de: string; en: string } | null;
}): EngineFinding[] {
  const [labelDe, labelEn] = pair(a.label, "Anesthesia clearance");
  const c = a.clearance;
  if (c === null || c.status === "MISSING") {
    if (!a.required) return [];
    return [
      finding({
        category: CLEARANCE,
        severity: CRITICAL,
        item: a.item,
        sourceRef: c ? c.id : a.item,
        role: ROLE_ANESTHESIA,
        de: `${labelDe} fehlt – bitte vor ${a.procedureType} am ${fmt(a.plannedDate)} einholen.`,
        en: `${labelEn} is missing – please obtain it before ${a.procedureType} on ${fmt(a.plannedDate)}.`,
      }),
    ];
  }

  const findings: EngineFinding[] = [];
  if (c.clearanceDate && c.clearanceDate > a.plannedDate) {
    findings.push(
      finding({
        category: IMPLAUSIBLE,
        severity: CRITICAL,
        item: a.item,
        sourceRef: c.id,
        role: ROLE_ANESTHESIA,
        de: `${labelDe} ist auf den ${fmt(c.clearanceDate)} datiert, nach dem geplanten Eingriff.`,
        en: `${labelEn} is dated ${fmt(c.clearanceDate)}, after the planned procedure.`,
      }),
    );
  }
  if (a.maxAge !== null && c.clearanceDate !== null) {
    const age = daysBetween(c.clearanceDate, a.plannedDate);
    const max = Math.trunc(a.maxAge);
    if (age > max) {
      findings.push(
        finding({
          category: OUTDATED,
          severity: WARNING,
          item: a.item,
          sourceRef: c.id,
          role: ROLE_ANESTHESIA,
          de: `${labelDe}: veraltet (${age} Tage, erlaubt ${max}).`,
          en: `${labelEn} is outdated (${age} days, allowed ${max}).`,
        }),
      );
    }
  }
  if (c.status === "CONDITIONAL") {
    const open = c.conditions.filter((x) => x.trim());
    const detail = open.length ? open.join("; ") : "keine Auflage dokumentiert";
    const detailEn = open.length ? open.join("; ") : "no condition documented";
    findings.push(
      finding({
        category: CLEARANCE,
        severity: WARNING,
        item: a.item,
        sourceRef: c.id,
        role: ROLE_ANESTHESIA,
        de: `${labelDe} nur bedingt: ${detail}.`,
        en: `${labelEn} is conditional: ${detailEn}.`,
      }),
    );
  } else if (c.status !== "GRANTED") {
    findings.push(
      finding({
        category: CLEARANCE,
        severity: WARNING,
        item: a.item,
        sourceRef: c.id,
        role: ROLE_ANESTHESIA,
        de: `${labelDe}: unbekannter Status „${c.status}“.`,
        en: `${labelEn}: unknown status “${c.status}”.`,
      }),
    );
  }
  return findings;
}

// ---------------------------------------------------------- medication

function checkMedications(a: {
  patientId: string;
  procedureType: string;
  plannedDate: ISODate;
  observations: Observation[];
  medications: Medication[];
  labsCfg: Record<string, LabThreshold>;
  consistency: ThresholdsDoc["consistency"];
}): EngineFinding[] {
  const pauseClasses = new Set((a.consistency.pauseRequiredClasses || []).map((c) => String(c).toUpperCase()));
  const egfrCode = String(a.consistency.egfrCode || "egfr");
  const egfrMin = a.consistency.metforminEgfrMin ?? null;
  const findings: EngineFinding[] = [];
  for (const med of a.medications) {
    if (med.patientId !== a.patientId) continue;
    if (pauseClasses.has(med.drugClass.toUpperCase()) && med.status === "ACTIVE" && med.pausedSince === null) {
      findings.push(
        finding({
          category: INCONSISTENT,
          severity: CRITICAL,
          item: `medication.${med.drugClass.toLowerCase()}`,
          sourceRef: med.id,
          de: `${med.name} (${med.drugClass}) ist weiter aktiv, ohne dokumentierte Pause vor ${a.procedureType} am ${fmt(a.plannedDate)}.`,
          en: `${med.name} (${med.drugClass}) is still active, with no documented pause before ${a.procedureType} on ${fmt(a.plannedDate)}.`,
        }),
      );
    }
    if (med.drugClass.toUpperCase() === "METFORMIN" && med.status === "ACTIVE" && egfrMin !== null) {
      const egfr = latestUsable(
        a.observations.filter((o) => o.patientId === a.patientId && o.code === egfrCode),
        a.plannedDate,
      );
      const spec = a.labsCfg[egfrCode];
      if (
        egfr &&
        egfr.value !== null &&
        unitsMatch(egfr.unit, String(spec?.unit || egfr.unit)) &&
        egfr.value < egfrMin
      ) {
        findings.push(
          finding({
            category: INCONSISTENT,
            severity: WARNING,
            item: "medication.metformin",
            sourceRef: med.id,
            de: `Metformin ist aktiv bei eGFR ${num(egfr.value)} (unter ${num(egfrMin)}) vor ${a.procedureType}.`,
            en: `Metformin is active with eGFR ${num(egfr.value)} (below ${num(egfrMin)}) before ${a.procedureType}.`,
          }),
        );
      }
    }
  }
  return findings;
}

function latestUsable(rows: Observation[], plannedDate: ISODate): Observation | null {
  const usable = rows.filter((r) => r.effectiveDate <= plannedDate);
  if (!usable.length) return null;
  let best = usable[0];
  for (const row of usable.slice(1)) if (row.effectiveDate > best.effectiveDate) best = row;
  return best;
}

// ------------------------------------------------------------- helpers

function finding(a: {
  category: string;
  severity: string;
  item: string;
  sourceRef: string;
  de: string;
  en: string;
  role?: string;
}): EngineFinding {
  return {
    category: a.category,
    severity: a.severity,
    item: a.item,
    messageDe: a.de,
    messageEn: a.en,
    sourceRef: a.sourceRef,
    role: a.role || roleFor(a.item, a.category),
  };
}

function roleFor(item: string, category: string): string {
  if (category === CLEARANCE || item.startsWith("clearance.")) return ROLE_ANESTHESIA;
  if (category === ABNORMAL || category === IMPLAUSIBLE || category === INCONSISTENT) return ROLE_PHYSICIAN;
  return ROLE_COORDINATION;
}

function dedupe(findings: EngineFinding[]): EngineFinding[] {
  const seen = new Set<string>();
  const unique: EngineFinding[] = [];
  for (const f of findings) {
    const key = JSON.stringify([f.category, f.item, f.sourceRef, f.messageDe]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  return unique;
}

function labLabels(code: string, spec: LabThreshold | null): [string, string] {
  return [String(spec?.labelDe || code), String(spec?.labelEn || code)];
}

function pair(label: { de: string; en: string } | null, fallback: string): [string, string] {
  return [String(label?.de || fallback), String(label?.en || fallback)];
}

export function unitsMatch(actual: string, expected: string): boolean {
  return normUnit(actual) === normUnit(expected);
}

function normUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/µ/g, "u").replace(/μ/g, "u").replace(/ /g, "");
}

export function num(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
