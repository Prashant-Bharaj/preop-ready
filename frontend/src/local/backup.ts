// Export / import / reset of the browser-local dataset.
// Data lives only in this browser, so a JSON backup is the way to move it.

import { clinicToday } from "./dates";
import { seededDb } from "./repository";
import { SCHEMA_VERSION, readSnapshot, replaceAll, type LocalDb } from "./store";

const FORMAT = "preop-ready-backup";
const MAX_IMPORT = 20_000_000;

export async function exportBackup(): Promise<Blob> {
  const db = (await readSnapshot()) ?? seededDb();
  const payload = { format: FORMAT, exportedAt: new Date().toISOString(), data: db };
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
}

export function backupFileName(): string {
  return `preop-ready-backup-${clinicToday()}.json`;
}

export async function importBackup(file: File): Promise<void> {
  if (file.size > MAX_IMPORT) throw new Error("too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("invalid");
  }
  const data = (parsed as { format?: string; data?: LocalDb })?.data;
  if ((parsed as { format?: string })?.format !== FORMAT || !isLocalDb(data)) throw new Error("invalid");
  await replaceAll(data);
}

/** Replace everything with a fresh synthetic demo cohort. */
export async function resetToDemo(): Promise<void> {
  await replaceAll(seededDb());
}

function isLocalDb(value: unknown): value is LocalDb {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const lists = [
    "patients",
    "procedures",
    "observations",
    "reports",
    "clearances",
    "medications",
    "findings",
    "tasks",
    "audit",
  ];
  return (
    v.version === SCHEMA_VERSION &&
    typeof v.config === "object" &&
    v.config !== null &&
    "requirements" in v.config &&
    "thresholds" in v.config &&
    lists.every((key) => Array.isArray(v[key]))
  );
}
