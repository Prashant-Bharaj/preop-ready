// Synthetic cohort — ported 1:1 from backend/app/demo_data.py.
// Dates are relative to the day the seed runs. No real patient data.

import { addDays, type ISODate } from "./dates";
import type { AnesthesiaClearance, DiagnosticReport, Medication, Observation } from "./engine";

export interface PatientRecord {
  id: string;
  name: string;
  birthDate: ISODate;
  sex: string;
  ward: string;
}

export interface ProcedureRecord {
  id: string;
  patientId: string;
  procedureType: string;
  plannedDate: ISODate;
  plannedTime: string;
  operator: string;
  status: string;
  readiness: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

export interface DemoWorld {
  patients: PatientRecord[];
  procedures: ProcedureRecord[];
  observations: Observation[];
  reports: DiagnosticReport[];
  clearances: AnesthesiaClearance[];
  medications: Medication[];
}

export const NORMAL_LABS: Record<string, [number, string]> = {
  hb: [13.4, "g/dL"],
  platelets: [240, "10^9/L"],
  inr: [1.0, "ratio"],
  aptt: [31, "s"],
  creatinine: [80, "µmol/L"],
  egfr: [78, "mL/min/1.73m2"],
  potassium: [4.1, "mmol/L"],
  sodium: [139, "mmol/L"],
  tsh: [1.6, "mU/L"],
  crp: [1.2, "mg/L"],
  bnp: [48, "pmol/L"],
};

function procedure(
  id: string,
  patientId: string,
  procedureType: string,
  plannedDate: ISODate,
  plannedTime: string,
): ProcedureRecord {
  return {
    id,
    patientId,
    procedureType,
    plannedDate,
    plannedTime,
    operator: "Dr. Test Operateur",
    status: "planned",
    readiness: null,
    confirmedBy: null,
    confirmedAt: null,
  };
}

export function buildDemoWorld(today: ISODate): DemoWorld {
  const planned = addDays(today, 1);
  const at = (days: number) => addDays(planned, days);

  const patients: PatientRecord[] = [
    { id: "pat-a", name: "Testperson A", birthDate: "1948-03-12", sex: "female", ward: "Station Kardiologie 1" },
    { id: "pat-b", name: "Testperson B", birthDate: "1952-07-01", sex: "male", ward: "Station Kardiologie 1" },
    { id: "pat-c", name: "Testperson C", birthDate: "1946-11-20", sex: "female", ward: "Station Kardiologie 2" },
    { id: "pat-d", name: "Testperson D", birthDate: "1955-01-09", sex: "male", ward: "Station Kardiologie 2" },
    { id: "pat-e", name: "Testperson E", birthDate: "1949-05-18", sex: "male", ward: "Station Kardiologie 1" },
    { id: "pat-f", name: "Testperson F", birthDate: "1951-09-30", sex: "female", ward: "Station Kardiologie 2" },
  ];
  const procedures = [
    procedure("proc-a", "pat-a", "TAVI", planned, "07:30"),
    procedure("proc-b", "pat-b", "M-TEER", planned, "08:15"),
    procedure("proc-c", "pat-c", "TAVI", planned, "09:00"),
    procedure("proc-d", "pat-d", "M-TEER", planned, "10:30"),
    procedure("proc-e", "pat-e", "TAVI", planned, "11:45"),
    procedure("proc-f", "pat-f", "TAVI", planned, "13:00"),
  ];

  const observations: Observation[] = [
    ...labs("pat-a", at(-2)),
    ...labs("pat-b", at(-10)),
    ...labs("pat-c", at(-1), { potassium: [2.4, "mmol/L"] }),
    ...labs("pat-d", at(-1)),
    ...labs("pat-e", at(-1), { creatinine: [1.1, "mg/dL"] }),
    ...labs("pat-f", at(-1)),
  ];

  const echoA = "Gute Schallbedingungen. LVEF 60 %. Aortenklappe hochgradig stenosiert.";
  const echoTee =
    "Transösophageale Echokardiographie (TEE). Schwere Mitralklappeninsuffizienz. " +
    "LVEF 55 %. Kein Thrombus im linken Vorhof.";
  const xray = "Keine Infiltrate. Herzgröße normal.";
  const ecg = "Sinusrhythmus, keine Ischämiezeichen.";
  const agreement =
    "Einverständniserklärung zum geplanten Eingriff. " + "Patientenunterschrift liegt vor. Aufklärung ist erfolgt.";
  const duplexPre = "Duplexsonographie der Leiste (transfemoraler Zugang): " + "Gefäße unauffällig, Zugang möglich.";
  const duplexPost = "Duplexsonographie der Leiste postinterventionell: " + "kein Aneurysma, keine Blutung.";
  const gastroscopy = "Gastroskopie einen Tag nach dem Eingriff: unauffälliger Befund.";

  const reports: DiagnosticReport[] = [
    report("pat-a", "ECHO", at(-20), echoA),
    report("pat-a", "CHEST_XRAY", at(-5), xray),
    report("pat-a", "ECG", at(-1), ecg),
    report("pat-a", "AGREEMENT", at(-2), agreement),
    report("pat-a", "DUPLEX_GROIN_PRE", at(-1), duplexPre),
    report("pat-a", "DUPLEX_GROIN_POST", at(1), duplexPost),
    report("pat-a", "GASTROSCOPY", at(1), gastroscopy),
    report("pat-a", "ECHO_6W", at(42), "Echo-Kontrolle 6 Wochen: Klappenfunktion stabil, LVEF 60 %."),
    report("pat-a", "ECHO_6M", at(183), "Echo-Kontrolle 6 Monate: kein Hinweis auf Klappendysfunktion."),
    report("pat-b", "ECHO", at(-10), echoTee),
    report("pat-b", "CHEST_XRAY", at(-4), xray),
    report("pat-b", "ECG", at(-2), ecg),
    report("pat-b", "AGREEMENT", at(-2), agreement),
    report("pat-b", "DUPLEX_GROIN_PRE", at(-1), duplexPre),
    report("pat-c", "CHEST_XRAY", at(-3), xray),
    report("pat-c", "ECG", at(-1), ecg),
    report("pat-d", "ECHO", at(-6), echoTee),
    report("pat-d", "CHEST_XRAY", at(-2), xray),
    report("pat-d", "ECG", at(-1), ecg),
    report("pat-d", "AGREEMENT", at(-2), agreement),
    report("pat-d", "DUPLEX_GROIN_PRE", at(-1), duplexPre),
    report("pat-e", "ECHO", at(-15), echoA),
    report("pat-e", "CHEST_XRAY", at(-4), xray),
    report("pat-e", "ECG", at(-1), ecg),
    report("pat-e", "AGREEMENT", at(-2), agreement),
    report("pat-e", "DUPLEX_GROIN_PRE", at(-1), duplexPre),
    report("pat-f", "ECHO", at(-12), echoA),
    report("pat-f", "CHEST_XRAY", at(1), xray),
    report("pat-f", "ECG", at(-1), ecg),
    report("pat-f", "AGREEMENT", at(-2), agreement),
    report("pat-f", "DUPLEX_GROIN_PRE", at(-1), duplexPre),
  ];

  const clearances = [
    clearance("pat-a", "GRANTED", at(-3), []),
    clearance("pat-b", "CONDITIONAL", at(-1), ["Kalium korrigieren"]),
    clearance("pat-d", "GRANTED", at(-2), []),
    clearance("pat-e", "GRANTED", at(-2), []),
    clearance("pat-f", "GRANTED", at(-1), []),
  ];

  const medications: Medication[] = [
    {
      id: "med-a-1",
      patientId: "pat-a",
      name: "Test-ASS",
      drugClass: "ANTIPLATELET",
      status: "PAUSED",
      pausedSince: at(-5),
      source: "synthetic-seed",
    },
    {
      id: "med-d-1",
      patientId: "pat-d",
      name: "Test-Apixaban",
      drugClass: "DOAC",
      status: "ACTIVE",
      pausedSince: null,
      source: "synthetic-seed",
    },
  ];

  return { patients, procedures, observations, reports, clearances, medications };
}

function labs(
  patientId: string,
  when: ISODate,
  overrides: Record<string, [number, string]> = {},
): Observation[] {
  const values = { ...NORMAL_LABS, ...overrides };
  return Object.entries(values).map(([code, [value, unit]]) => ({
    id: `obs-${patientId}-${code}`,
    patientId,
    code,
    value,
    unit,
    effectiveDate: when,
    source: "synthetic-seed",
    documentPatientId: null,
  }));
}

function report(patientId: string, reportType: string, when: ISODate, text: string): DiagnosticReport {
  return {
    id: `rep-${patientId}-${reportType.toLowerCase()}`,
    patientId,
    reportType,
    reportDate: when,
    conclusionText: text,
    source: "synthetic-seed",
    evidence: text.slice(0, 180),
    documentPatientId: null,
  };
}

function clearance(patientId: string, status: string, when: ISODate, conditions: string[]): AnesthesiaClearance {
  return {
    id: `clr-${patientId}`,
    patientId,
    status,
    clearanceDate: when,
    asaClass: "ASA II",
    conditions,
    anesthetist: "Dr. Test Anaesthesie",
    source: "synthetic-seed",
  };
}
