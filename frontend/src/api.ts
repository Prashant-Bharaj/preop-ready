export type Readiness = "GREEN" | "YELLOW" | "RED";

export interface Meta {
  today: string;
  tomorrow: string;
  horizon: string;
  llmConfigured: boolean;
  user: { name: string; userId: string };
  disclaimer: string;
}

export interface ProcedureRow {
  id: string;
  time: string;
  date: string;
  patientId: string;
  patientName: string;
  procedureType: string;
  readiness: Readiness;
  openIssues: number;
  clearance: string;
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  operator: string;
}

export interface Finding {
  id?: string;
  procedureId?: string;
  category: string;
  severity: string;
  item: string;
  messageDe: string;
  messageEn: string;
  sourceRef: string;
  role: string;
}

export interface ChecklistItem {
  item: string;
  labelDe: string;
  labelEn: string;
  state: "complete" | "missing" | "outdated" | "warning" | "critical";
  required: boolean;
  maxAgeDays: number | null;
  detailDe: string;
  detailEn: string;
  sourceRef: string;
}

export interface ProcedureDetail {
  id: string;
  procedureType: string;
  plannedDate: string;
  plannedTime: string;
  operator: string;
  readiness: Readiness;
  openIssues: number;
  confirmedBy: string | null;
  confirmedAt: string | null;
  checklist: ChecklistItem[];
  findings: Finding[];
}

export interface LabRow {
  id: string;
  code: string;
  labelDe: string;
  labelEn: string;
  value: number | null;
  unit: string;
  effectiveDate: string;
  expectedUnit: string | null;
  low: number | null;
  high: number | null;
  flag: "normal" | "warning" | "critical";
  source: string;
  documentPatientId: string | null;
}

export interface ReportRow {
  id: string;
  type: string;
  date: string | null;
  conclusionText: string;
  evidence: string | null;
  sourceFile: string;
  documentPatientId: string | null;
  extractedFindings: { name?: string; value?: number | null; unit?: string | null; evidence?: string | null }[];
}

export interface MedicationRow {
  id: string;
  name: string;
  class: string;
  status: string;
  pausedSince: string | null;
  source: string;
}

export interface Clearance {
  id: string;
  status: string;
  date: string | null;
  asaClass: string | null;
  conditions: string[];
  anesthetist: string | null;
  source: string;
}

export interface PatientDetail {
  patient: {
    id: string;
    name: string;
    birthDate: string;
    sex: string;
    ward: string;
  };
  procedures: ProcedureDetail[];
  labs: LabRow[];
  reports: ReportRow[];
  medications: MedicationRow[];
  clearance: Clearance | null;
}

export interface TaskRow {
  id: string;
  procedureId: string;
  patientId: string;
  patientName: string;
  procedureType: string;
  plannedDate: string;
  plannedTime: string;
  textDe: string;
  textEn: string;
  assignedRole: string;
  status: "OPEN" | "DONE";
  sourceRef: string;
  category: string;
}

export interface Extraction {
  reportType: string;
  date: string | null;
  patientId: string | null;
  patientName: string | null;
  findings: { name: string; value: number | null; unit: string | null; evidence: string | null }[];
  clearanceStatus: string | null;
  conditions: string[];
  asaClass: string | null;
  conclusionText: string | null;
  manualReviewNeeded: boolean;
}

export interface ExtractResponse {
  extraction: Extraction;
  manualReviewNeeded: boolean;
  source: string;
  message: string;
}

export interface RequirementItem {
  item: string;
  required: boolean;
  maxAgeDays: number | null;
  mustMention?: string | null;
}

export interface RequirementsDoc {
  disclaimer: string;
  labels: Record<string, { de: string; en: string }>;
  procedures: Record<string, RequirementItem[]>;
}

export interface LabThreshold {
  labelDe: string;
  labelEn: string;
  low: number | null;
  high: number | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  implausibleLow: number | null;
  implausibleHigh: number | null;
  unit: string;
}

export interface ThresholdsDoc {
  disclaimer: string;
  labs: Record<string, LabThreshold>;
  aliases: Record<string, string>;
  consistency: {
    pauseRequiredClasses: string[];
    metforminEgfrMin: number | null;
    egfrCode: string;
  };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api${path}`, { ...init, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.message || "Request failed");
  }
  return data as T;
}

export function formatDate(iso: string, lang: "de" | "en"): string {
  const day = iso.slice(0, 10);
  const [year, month, date] = day.split("-");
  if (!year || !month || !date) return iso;
  return lang === "de" ? `${date}.${month}.${year}` : `${year}-${month}-${date}`;
}

export function formatStamp(iso: string | null, lang: "de" | "en"): string {
  if (!iso) return "";
  return `${formatDate(iso, lang)} ${iso.slice(11, 16)}`;
}
