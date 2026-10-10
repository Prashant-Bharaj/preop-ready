// Read and write clinical rows — a port of backend/app/repository.py over the
// in-browser document (see store.ts). The rule engine stays pure.

import type { RequirementsDoc, ThresholdsDoc } from "../api";
import { defaultRequirements, defaultThresholds } from "./configDefaults";
import { addDays, clinicToday, daysBetween, nowStamp, type ISODate } from "./dates";
import { buildDemoWorld, type DemoWorld } from "./demoData";
import { evaluateCase, itemState, overallStatus, type EngineFinding } from "./engine";
import { SCHEMA_VERSION, type FindingRow, type LocalDb, type StoredReport, type TaskRecord } from "./store";

export interface Actor {
  name: string;
  userId: string;
}

export const LOCAL_ACTOR: Actor = { name: "Lokale Sitzung", userId: "local" };

export function newId(prefix = "", length = 32): string {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, length);
  return prefix ? `${prefix}${hex}` : hex;
}

// ---------------------------------------------------------------- seeding

export function emptyDb(): LocalDb {
  return {
    version: SCHEMA_VERSION,
    seededOn: "",
    config: { requirements: defaultRequirements(), thresholds: defaultThresholds() },
    patients: [],
    procedures: [],
    observations: [],
    reports: [],
    clearances: [],
    medications: [],
    findings: [],
    tasks: [],
    audit: [],
  };
}

export function seededDb(today: ISODate = clinicToday()): LocalDb {
  const db = emptyDb();
  insertWorld(db, buildDemoWorld(today), today);
  db.seededOn = today;
  return db;
}

function insertWorld(db: LocalDb, world: DemoWorld, asOf: ISODate): void {
  db.config = { requirements: defaultRequirements(), thresholds: defaultThresholds() };
  db.patients.push(...world.patients);
  db.procedures.push(...world.procedures);
  db.observations.push(...world.observations);
  db.reports.push(...world.reports.map((r) => ({ ...r, extractedFindings: null })));
  db.clearances.push(...world.clearances);
  db.medications.push(...world.medications);
  for (const procedure of world.procedures) runCheck(db, procedure.id, asOf);
}

// ----------------------------------------------------------------- checks

export interface CheckResult {
  procedureId: string;
  readiness: string;
  openIssues: number;
  findings: ReturnType<typeof findingDict>[];
}

export function runCheck(db: LocalDb, procedureId: string, asOf?: ISODate): CheckResult | null {
  const procedure = db.procedures.find((p) => p.id === procedureId);
  if (!procedure) return null;
  const patientId = procedure.patientId;
  const findings = evaluateCase({
    patientId,
    procedureType: procedure.procedureType,
    plannedDate: procedure.plannedDate,
    observations: db.observations.filter((o) => o.patientId === patientId),
    reports: db.reports.filter((r) => r.patientId === patientId),
    clearance: clearanceFor(db, patientId),
    medications: db.medications.filter((m) => m.patientId === patientId),
    requirementsDoc: db.config.requirements,
    thresholdsDoc: db.config.thresholds,
    asOf: asOf || clinicToday(),
  });
  const readiness = persistFindings(db, procedureId, patientId, findings);
  return {
    procedureId,
    readiness,
    openIssues: openTaskCount(db, procedureId),
    findings: findings.map((f) => findingDict(f, null)),
  };
}

export function runCheckAll(db: LocalDb): CheckResult[] {
  return sortBy(db.procedures, (p) => [p.plannedDate, p.plannedTime]).map((p) => runCheck(db, p.id)!);
}

type DoneKey = string;
const keyOf = (item: string, category: string, sourceRef: string): DoneKey =>
  JSON.stringify([item, category, sourceRef]);

function doneKeys(db: LocalDb, procedureId: string): Set<DoneKey> {
  return new Set(
    db.tasks
      .filter((t) => t.procedureId === procedureId && t.status === "DONE")
      .map((t) => keyOf(t.item, t.category, t.sourceRef)),
  );
}

function activeFindings<T extends { item: string; category: string; sourceRef: string }>(
  findings: T[],
  done: Set<DoneKey>,
): T[] {
  return findings.filter((f) => !done.has(keyOf(f.item, f.category, f.sourceRef)));
}

function recomputeReadiness(db: LocalDb, procedureId: string): string {
  const findings = db.findings.filter((f) => f.procedureId === procedureId);
  const readiness = overallStatus(activeFindings(findings, doneKeys(db, procedureId)));
  const procedure = db.procedures.find((p) => p.id === procedureId);
  if (procedure) procedure.readiness = readiness;
  return readiness;
}

function persistFindings(db: LocalDb, procedureId: string, patientId: string, findings: EngineFinding[]): string {
  const done = doneKeys(db, procedureId);
  db.findings = db.findings.filter((f) => f.procedureId !== procedureId);
  db.tasks = db.tasks.filter((t) => !(t.procedureId === procedureId && t.status === "OPEN"));
  const alive = new Set<DoneKey>();
  for (const f of findings) {
    const findingId = newId();
    db.findings.push({ id: findingId, procedureId, patientId, ...f });
    const key = keyOf(f.item, f.category, f.sourceRef);
    alive.add(key);
    if (done.has(key)) continue;
    db.tasks.push({
      id: newId(),
      procedureId,
      patientId,
      findingId,
      item: f.item,
      category: f.category,
      sourceRef: f.sourceRef,
      textDe: f.messageDe,
      textEn: f.messageEn,
      assignedRole: f.role,
      status: "OPEN",
    });
  }
  // Drop DONE markers whose finding no longer exists.
  db.tasks = db.tasks.filter(
    (t) => !(t.procedureId === procedureId && t.status === "DONE" && !alive.has(keyOf(t.item, t.category, t.sourceRef))),
  );
  const remainingDone = new Set([...done].filter((k) => alive.has(k)));
  const readiness = overallStatus(activeFindings(findings, remainingDone));
  const procedure = db.procedures.find((p) => p.id === procedureId);
  if (procedure) procedure.readiness = readiness;
  return readiness;
}

function openTaskCount(db: LocalDb, procedureId: string): number {
  return db.tasks.filter((t) => t.procedureId === procedureId && t.status === "OPEN").length;
}

// ------------------------------------------------------------------ reads

export function listProcedures(db: LocalDb, on: ISODate) {
  const rows = sortBy(
    db.procedures.filter((p) => p.plannedDate === on),
    (p) => [p.plannedTime],
  );
  return rows.flatMap((p) => {
    const patient = db.patients.find((pt) => pt.id === p.patientId);
    if (!patient) return [];
    return [
      {
        id: p.id,
        time: p.plannedTime,
        date: p.plannedDate,
        patientId: p.patientId,
        patientName: patient.name,
        procedureType: p.procedureType,
        readiness: p.readiness || "YELLOW",
        openIssues: openTaskCount(db, p.id),
        clearance: clearanceFor(db, p.patientId)?.status || "MISSING",
        confirmed: Boolean(p.confirmedAt),
        confirmedBy: p.confirmedBy,
        confirmedAt: p.confirmedAt,
        operator: p.operator,
      },
    ];
  });
}

export function listPatientOptions(db: LocalDb) {
  return sortBy(db.patients, (p) => [p.name]).map((p) => ({ id: p.id, name: p.name }));
}

export function getPatient(db: LocalDb, patientId: string) {
  const patient = db.patients.find((p) => p.id === patientId);
  if (!patient) return null;
  const requirements = db.config.requirements;
  const thresholds = db.config.thresholds;
  const procedures = sortBy(
    db.procedures.filter((p) => p.patientId === patientId),
    (p) => [p.plannedDate, p.plannedTime],
  );
  const findings = sortBy(
    db.findings.filter((f) => f.patientId === patientId),
    (f) => [f.severity === "CRITICAL" ? "0" : "1", f.category],
  );
  return {
    patient: {
      id: patient.id,
      name: patient.name,
      birthDate: patient.birthDate,
      sex: patient.sex,
      ward: patient.ward,
    },
    procedures: procedures.map((p) => procedureDetail(db, p, requirements, thresholds, findings)),
    labs: labRows(db, patientId, thresholds, findings),
    reports: reportRows(db, patientId),
    medications: sortBy(
      db.medications.filter((m) => m.patientId === patientId),
      (m) => [m.name],
    ).map((m) => ({
      id: m.id,
      name: m.name,
      class: m.drugClass,
      status: m.status,
      pausedSince: m.pausedSince,
      source: m.source,
    })),
    clearance: clearanceDict(db, patientId),
  };
}

function procedureDetail(
  db: LocalDb,
  row: LocalDb["procedures"][number],
  requirements: RequirementsDoc,
  thresholds: ThresholdsDoc,
  findings: FindingRow[],
) {
  const own = findings.filter((f) => f.procedureId === row.id);
  const activeOwn = activeFindings(own, doneKeys(db, row.id));
  const rules = (requirements.procedures || {})[row.procedureType] || [];
  const labels = requirements.labels || {};
  const checklist = rules.map((rule) => {
    const item = rule.item;
    const related = activeOwn.filter((f) => f.item === item);
    const [labelDe, labelEn] = itemLabel(item, labels, thresholds);
    const detail = related[0];
    return {
      item,
      labelDe,
      labelEn,
      state: itemState(item, related),
      required: rule.required === undefined ? true : Boolean(rule.required),
      maxAgeDays: rule.maxAgeDays ?? null,
      detailDe: detail ? detail.messageDe : "",
      detailEn: detail ? detail.messageEn : "",
      sourceRef: detail ? detail.sourceRef : "",
    };
  });
  return {
    id: row.id,
    procedureType: row.procedureType,
    plannedDate: row.plannedDate,
    plannedTime: row.plannedTime,
    operator: row.operator,
    status: row.status,
    readiness: row.readiness || overallStatus([]),
    openIssues: openTaskCount(db, row.id),
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
    checklist,
    findings: activeOwn,
  };
}

function itemLabel(
  item: string,
  labels: RequirementsDoc["labels"],
  thresholds: ThresholdsDoc,
): [string, string] {
  const suffix = item.split(".").slice(1).join(".");
  if (item.startsWith("lab.")) {
    const spec = (thresholds.labs || {})[suffix];
    return [spec?.labelDe || suffix, spec?.labelEn || suffix];
  }
  const pair = labels[item];
  const fallback = item.includes(".") ? suffix : item;
  return [pair?.de || fallback, pair?.en || fallback];
}

function labRows(db: LocalDb, patientId: string, thresholds: ThresholdsDoc, findings: FindingRow[]) {
  const rows = sortBy(
    db.observations.filter((o) => o.patientId === patientId),
    (o) => [o.code],
  );
  // Latest per code (effective_date DESC; first stored wins on ties).
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const current = latest.get(row.code);
    if (!current || row.effectiveDate > current.effectiveDate) latest.set(row.code, row);
  }
  const labsCfg = thresholds.labs || {};
  const result = [...latest.entries()].map(([code, row]) => {
    const spec = labsCfg[code];
    const related = findings.filter((f) => f.item === `lab.${code}`);
    let flag: "normal" | "warning" | "critical" = "normal";
    if (related.some((f) => f.severity === "CRITICAL")) flag = "critical";
    else if (related.length) flag = "warning";
    return {
      id: row.id,
      code,
      labelDe: spec?.labelDe || code,
      labelEn: spec?.labelEn || code,
      value: row.value,
      unit: row.unit,
      effectiveDate: row.effectiveDate,
      expectedUnit: spec?.unit ?? null,
      low: spec?.low ?? null,
      high: spec?.high ?? null,
      criticalLow: spec?.criticalLow ?? null,
      criticalHigh: spec?.criticalHigh ?? null,
      flag,
      source: row.source,
      documentPatientId: row.documentPatientId ?? null,
    };
  });
  return sortBy(result, (r) => [r.labelDe]);
}

function reportRows(db: LocalDb, patientId: string) {
  const rows = db.reports.filter((r) => r.patientId === patientId);
  // report_date DESC, NULL dates last.
  const ordered = [...rows].sort((a, b) => {
    if (a.reportDate === b.reportDate) return 0;
    if (a.reportDate === null) return 1;
    if (b.reportDate === null) return -1;
    return a.reportDate < b.reportDate ? 1 : -1;
  });
  return ordered.map((r) => ({
    id: r.id,
    type: r.reportType,
    date: r.reportDate,
    conclusionText: r.conclusionText,
    evidence: r.evidence ?? null,
    sourceFile: r.source,
    documentPatientId: r.documentPatientId ?? null,
    extractedFindings: r.extractedFindings || [],
  }));
}

function clearanceFor(db: LocalDb, patientId: string) {
  return db.clearances.find((c) => c.patientId === patientId) || null;
}

function clearanceDict(db: LocalDb, patientId: string) {
  const c = clearanceFor(db, patientId);
  if (!c) return null;
  return {
    id: c.id,
    status: c.status,
    date: c.clearanceDate,
    asaClass: c.asaClass,
    conditions: [...c.conditions],
    anesthetist: c.anesthetist,
    source: c.source,
  };
}

// ----------------------------------------------------------------- tasks

export function listTasks(db: LocalDb, status: string | null, role: string | null, patientId: string | null) {
  const rows = db.tasks.filter(
    (t) => (!status || t.status === status) && (!role || t.assignedRole === role) && (!patientId || t.patientId === patientId),
  );
  const joined = rows.flatMap((t) => {
    const patient = db.patients.find((p) => p.id === t.patientId);
    const procedure = db.procedures.find((p) => p.id === t.procedureId);
    return patient && procedure ? [taskDict(t, patient.name, procedure)] : [];
  });
  return sortBy(joined, (t) => [t.plannedDate, t.plannedTime, t.assignedRole]);
}

function taskDict(t: TaskRecord, patientName: string, procedure: LocalDb["procedures"][number]) {
  return {
    id: t.id,
    procedureId: t.procedureId,
    patientId: t.patientId,
    patientName,
    procedureType: procedure.procedureType,
    plannedDate: procedure.plannedDate,
    plannedTime: procedure.plannedTime,
    item: t.item,
    category: t.category,
    textDe: t.textDe,
    textEn: t.textEn,
    assignedRole: t.assignedRole,
    status: t.status,
    sourceRef: t.sourceRef,
  };
}

export function updateTaskStatus(db: LocalDb, taskId: string, status: "OPEN" | "DONE", actor: Actor) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  task.status = status;
  writeAudit(db, "task.status", actor, "task", taskId, { status, procedureId: task.procedureId });
  recomputeReadiness(db, task.procedureId);
  const patient = db.patients.find((p) => p.id === task.patientId);
  const procedure = db.procedures.find((p) => p.id === task.procedureId);
  return patient && procedure ? taskDict(task, patient.name, procedure) : null;
}

export function markChecklistItemDone(db: LocalDb, procedureId: string, item: string, actor: Actor) {
  const procedure = db.procedures.find((p) => p.id === procedureId);
  if (!procedure) return null;
  let marked = 0;
  const openIds = db.tasks
    .filter((t) => t.procedureId === procedureId && t.item === item && t.status === "OPEN")
    .map((t) => t.id);
  for (const id of openIds) {
    if (updateTaskStatus(db, id, "DONE", actor)) marked += 1;
  }
  if (marked === 0) {
    const findings = db.findings.filter((f) => f.procedureId === procedureId && f.item === item);
    for (const f of findings) {
      const already = db.tasks.some(
        (t) =>
          t.procedureId === procedureId &&
          t.item === item &&
          t.category === f.category &&
          t.sourceRef === f.sourceRef &&
          t.status === "DONE",
      );
      if (already) continue;
      db.tasks.push({
        id: newId(),
        procedureId,
        patientId: procedure.patientId,
        findingId: null,
        item,
        category: f.category,
        sourceRef: f.sourceRef,
        textDe: f.messageDe,
        textEn: f.messageEn,
        assignedRole: f.role,
        status: "DONE",
      });
      marked += 1;
    }
    if (marked) {
      writeAudit(db, "checklist.item.done", actor, "procedure", procedureId, { itemKey: item, marked });
      recomputeReadiness(db, procedureId);
    }
  }
  return { procedureId, itemKey: item, marked, readiness: procedure.readiness };
}

export function confirmProcedure(db: LocalDb, procedureId: string, actor: Actor) {
  const procedure = db.procedures.find((p) => p.id === procedureId);
  if (!procedure) return null;
  const stamped = nowStamp();
  procedure.confirmedBy = actor.name;
  procedure.confirmedAt = stamped;
  writeAudit(db, "procedure.confirm", actor, "procedure", procedureId, {
    readinessAtConfirm: procedure.readiness,
    confirmedAt: stamped,
  });
  return { procedureId, confirmedBy: actor.name, confirmedAt: stamped, readiness: procedure.readiness };
}

// ------------------------------------------------------------------ cases

export interface NewCase {
  name: string;
  birthDate: ISODate;
  sex: string;
  ward: string;
  procedureType: string;
  plannedDate: ISODate;
  plannedTime: string;
  operator: string;
}

export function createCase(db: LocalDb, payload: NewCase, actor: Actor) {
  if (!((db.config.requirements.procedures || {})[payload.procedureType])) return null;
  const today = clinicToday();
  if (payload.birthDate > today || Number(payload.birthDate.slice(0, 4)) < 1900) return null;
  if (payload.plannedDate < today || daysBetween(today, payload.plannedDate) > 60) return null;
  const patientId = newId("pat-", 12);
  const procedureId = newId("proc-", 12);
  db.patients.push({
    id: patientId,
    name: payload.name,
    birthDate: payload.birthDate,
    sex: payload.sex,
    ward: payload.ward,
  });
  db.procedures.push({
    id: procedureId,
    patientId,
    procedureType: payload.procedureType,
    plannedDate: payload.plannedDate,
    plannedTime: payload.plannedTime,
    operator: payload.operator,
    status: "planned",
    readiness: null,
    confirmedBy: null,
    confirmedAt: null,
  });
  writeAudit(db, "patient.create", actor, "patient", patientId, {
    procedureId,
    procedureType: payload.procedureType,
  });
  const checked = runCheck(db, procedureId);
  return {
    patientId,
    procedureId,
    patientName: payload.name,
    plannedDate: payload.plannedDate,
    readiness: checked?.readiness ?? null,
    openIssues: checked?.openIssues ?? 0,
    tasks: listTasks(db, "OPEN", null, patientId),
  };
}

// ----------------------------------------------------------------- config

export function putConfig<K extends "requirements" | "thresholds">(
  db: LocalDb,
  key: K,
  document: LocalDb["config"][K],
  actor: Actor,
): LocalDb["config"][K] {
  db.config[key] = document;
  writeAudit(db, "config.update", actor, "config", key, { key });
  runCheckAll(db);
  return document;
}

// ------------------------------------------------------------- extraction

const REPORT_TYPES = new Set([
  "ECHO",
  "CHEST_XRAY",
  "ECG",
  "AGREEMENT",
  "DUPLEX_GROIN_PRE",
  "DUPLEX_GROIN_POST",
  "GASTROSCOPY",
  "ECHO_6W",
  "ECHO_6M",
]);

export interface ExtractionInput {
  reportType: string;
  date: ISODate | null;
  patientId: string | null;
  patientName: string | null;
  findings: { name: string; value: number | null; unit: string | null; evidence: string | null }[];
  clearanceStatus: string | null;
  conditions: string[];
  asaClass: string | null;
  conclusionText: string | null;
  manualReviewNeeded: boolean;
}

export function saveExtraction(db: LocalDb, patientId: string, extraction: ExtractionInput, sourceName: string) {
  if (!db.patients.some((p) => p.id === patientId)) return null;
  const { reportType, date: reportDate } = extraction;
  const documentPatientId = extraction.patientId;
  const ids: string[] = [];

  if (reportType === "LAB") {
    const aliases = Object.fromEntries(
      Object.entries(db.config.thresholds.aliases || {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const f of extraction.findings) {
      const code = aliases[String(f.name || "").trim().toLowerCase()];
      if (!code || f.value === null || f.value === undefined || !reportDate) continue;
      const id = newId("obs-upload-", 10);
      db.observations.push({
        id,
        patientId,
        code,
        value: Number(f.value),
        unit: String(f.unit || ""),
        effectiveDate: reportDate,
        source: sourceName,
        documentPatientId,
      });
      ids.push(id);
    }
  } else if (reportType === "ANESTHESIA") {
    const id = `clr-upload-${patientId}`;
    db.clearances = db.clearances.filter((c) => c.patientId !== patientId);
    db.clearances.push({
      id,
      patientId,
      status: extraction.clearanceStatus || "MISSING",
      clearanceDate: reportDate || null,
      asaClass: extraction.asaClass,
      conditions: [...(extraction.conditions || [])],
      anesthetist: null,
      source: sourceName,
    });
    ids.push(id);
  } else if (REPORT_TYPES.has(reportType)) {
    const id = newId("rep-upload-", 10);
    const evidence = extraction.findings
      .map((f) => f.evidence)
      .filter(Boolean)
      .join("; ")
      .slice(0, 500);
    const report: StoredReport = {
      id,
      patientId,
      reportType,
      reportDate: reportDate || null,
      conclusionText: extraction.conclusionText || "",
      source: sourceName,
      documentPatientId,
      evidence: evidence || null,
      extractedFindings: extraction.findings || [],
    };
    db.reports.push(report);
    ids.push(id);
  }

  const checks = db.procedures.filter((p) => p.patientId === patientId).map((p) => runCheck(db, p.id));
  return { patientId, reportType, ids, checks };
}

// ------------------------------------------------------------------ audit

export function writeAudit(
  db: LocalDb,
  eventType: string,
  actor: Actor,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
): void {
  db.audit.push({
    id: newId(),
    eventType,
    actorId: actor.userId,
    actorName: actor.name,
    entityType,
    entityId,
    detail,
    createdAt: nowStamp(),
  });
  // Keep the local audit trail bounded.
  if (db.audit.length > 2000) db.audit.splice(0, db.audit.length - 2000);
}

// ---------------------------------------------------------------- helpers

export function tomorrow(today: ISODate = clinicToday()): ISODate {
  return addDays(today, 1);
}

function findingDict(f: EngineFinding, procedureId: string | null) {
  return { procedureId, ...f };
}

/** Stable multi-key sort using plain code-point comparison (like SQLite / Python). */
function sortBy<T>(rows: T[], key: (row: T) => string[]): T[] {
  return rows
    .map((row, index) => ({ row, index, k: key(row) }))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) {
        if (a.k[i] < b.k[i]) return -1;
        if (a.k[i] > b.k[i]) return 1;
      }
      return a.index - b.index;
    })
    .map((x) => x.row);
}
