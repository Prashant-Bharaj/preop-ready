// Browser-local persistence. The whole dataset is small, so it lives as one
// versioned document in IndexedDB. Every API call runs inside `transact`,
// which serialises work and writes the document back only on success —
// a failed call leaves the stored data untouched (like a DB rollback).

import type { RequirementsDoc, ThresholdsDoc } from "../api";
import type { PatientRecord, ProcedureRecord } from "./demoData";
import type { AnesthesiaClearance, DiagnosticReport, Medication, Observation } from "./engine";

export const SCHEMA_VERSION = 1;

export interface StoredReport extends DiagnosticReport {
  extractedFindings: unknown[] | null;
}

export interface FindingRow {
  id: string;
  procedureId: string;
  patientId: string;
  category: string;
  severity: string;
  item: string;
  messageDe: string;
  messageEn: string;
  sourceRef: string;
  role: string;
}

export interface TaskRecord {
  id: string;
  procedureId: string;
  patientId: string;
  findingId: string | null;
  item: string;
  category: string;
  sourceRef: string;
  textDe: string;
  textEn: string;
  assignedRole: string;
  status: "OPEN" | "DONE";
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actorId: string;
  actorName: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface LocalDb {
  version: number;
  seededOn: string;
  config: { requirements: RequirementsDoc; thresholds: ThresholdsDoc };
  patients: PatientRecord[];
  procedures: ProcedureRecord[];
  observations: Observation[];
  reports: StoredReport[];
  clearances: AnesthesiaClearance[];
  medications: Medication[];
  findings: FindingRow[];
  tasks: TaskRecord[];
  audit: AuditEvent[];
}

const DB_NAME = "preop-ready";
const STORE = "kv";
const KEY = "db";

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let idbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (!idbPromise) idbPromise = openIdb();
  return idbPromise;
}

async function readRaw(): Promise<LocalDb | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve((request.result as LocalDb | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function writeRaw(value: LocalDb): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `work` against a private copy of the database. If it resolves, the copy
 * is persisted; if it throws, nothing is written. Calls never interleave.
 */
export function transact<T>(work: (db: LocalDb) => T | Promise<T>, init: () => LocalDb): Promise<T> {
  const run = queue.then(async () => {
    const current = (await readRaw()) ?? null;
    const working = current && current.version === SCHEMA_VERSION ? structuredClone(current) : init();
    const result = await work(working);
    await writeRaw(working);
    return result;
  });
  // Keep the queue alive after a failure.
  queue = run.catch(() => undefined);
  return run;
}

export function readSnapshot(): Promise<LocalDb | null> {
  const run = queue.then(() => readRaw());
  queue = run.catch(() => undefined);
  return run;
}

export function replaceAll(next: LocalDb): Promise<void> {
  const run = queue.then(() => writeRaw(next));
  queue = run.catch(() => undefined);
  return run;
}
