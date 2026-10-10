// Demo requirements and thresholds — ported 1:1 from backend/app/config_defaults.py.
// Every numeric cutoff the rule engine reads comes from these documents
// (or from a later edit saved in Settings). The engine has no clinical literals.

import type { RequirementItem, RequirementsDoc, ThresholdsDoc } from "../api";

export const DISCLAIMER = "Demo-Werte – klinisch zu validieren";

const LAB_CODES = [
  "hb",
  "platelets",
  "inr",
  "aptt",
  "creatinine",
  "egfr",
  "potassium",
  "sodium",
  "tsh",
  "crp",
  "bnp",
];

function labRequirements(maxAgeDays: number): RequirementItem[] {
  return LAB_CODES.map((code) => ({ item: `lab.${code}`, required: true, maxAgeDays }));
}

function postItems(): RequirementItem[] {
  return [
    { item: "report.DUPLEX_GROIN_PRE", required: true, maxAgeDays: 1, timing: "pre" },
    { item: "report.DUPLEX_GROIN_POST", required: true, maxAgeDays: null, timing: "post", offsetDays: 1 },
    { item: "report.GASTROSCOPY", required: true, maxAgeDays: null, timing: "post", offsetDays: 1 },
    { item: "report.ECHO_6W", required: true, maxAgeDays: null, timing: "post", offsetDays: 42 },
    { item: "report.ECHO_6M", required: true, maxAgeDays: null, timing: "post", offsetDays: 183 },
    { item: "clearance.anesthesia", required: true, maxAgeDays: null },
  ];
}

const DEFAULT_REQUIREMENTS: RequirementsDoc = {
  disclaimer: DISCLAIMER,
  labels: {
    "report.ECHO": { de: "Echokardiographie", en: "Echocardiography" },
    "report.CHEST_XRAY": { de: "Röntgen-Thorax", en: "Chest X-ray" },
    "report.ECG": { de: "EKG", en: "ECG" },
    "report.AGREEMENT": { de: "Einverständniserklärung", en: "Patient agreement" },
    "report.DUPLEX_GROIN_PRE": { de: "Duplex Leiste (Tag vor Eingriff)", en: "Groin duplex (day before)" },
    "report.DUPLEX_GROIN_POST": { de: "Duplex Leiste (Tag nach Eingriff)", en: "Groin duplex (day after)" },
    "report.GASTROSCOPY": { de: "Gastroskopie (Tag nach Eingriff)", en: "Gastroscopy (day after)" },
    "report.ECHO_6W": { de: "Echo-Kontrolle (6 Wochen)", en: "Echo follow-up (6 weeks)" },
    "report.ECHO_6M": { de: "Echo-Kontrolle (6 Monate)", en: "Echo follow-up (6 months)" },
    "clearance.anesthesia": { de: "Anästhesiefreigabe", en: "Anesthesia clearance" },
  },
  procedures: {
    TAVI: [
      ...labRequirements(7),
      { item: "report.ECHO", required: true, maxAgeDays: 90 },
      { item: "report.CHEST_XRAY", required: true, maxAgeDays: 30 },
      { item: "report.ECG", required: true, maxAgeDays: 7 },
      { item: "report.AGREEMENT", required: true, maxAgeDays: 30, mustMention: "Patientenunterschrift" },
      ...postItems(),
    ],
    "M-TEER": [
      ...labRequirements(7),
      { item: "report.ECHO", required: true, maxAgeDays: 30, mustMention: "TEE" },
      { item: "report.CHEST_XRAY", required: true, maxAgeDays: 30 },
      { item: "report.ECG", required: true, maxAgeDays: 7 },
      { item: "report.AGREEMENT", required: true, maxAgeDays: 30, mustMention: "Patientenunterschrift" },
      ...postItems(),
    ],
  },
};

const DEFAULT_THRESHOLDS: ThresholdsDoc = {
  disclaimer: DISCLAIMER,
  labs: {
    hb: { labelDe: "Hämoglobin", labelEn: "Hemoglobin", low: 12.0, high: 17.5, criticalLow: 7.0, criticalHigh: 20.0, implausibleLow: 2.0, implausibleHigh: 25.0, unit: "g/dL" },
    platelets: { labelDe: "Thrombozyten", labelEn: "Platelets", low: 150, high: 400, criticalLow: 50, criticalHigh: 1000, implausibleLow: 1, implausibleHigh: 2000, unit: "10^9/L" },
    inr: { labelDe: "INR", labelEn: "INR", low: 0.8, high: 1.2, criticalLow: null, criticalHigh: 4.5, implausibleLow: 0.2, implausibleHigh: 15, unit: "ratio" },
    aptt: { labelDe: "aPTT", labelEn: "aPTT", low: 25, high: 40, criticalLow: null, criticalHigh: 100, implausibleLow: 5, implausibleHigh: 300, unit: "s" },
    creatinine: { labelDe: "Kreatinin", labelEn: "Creatinine", low: 44, high: 106, criticalLow: null, criticalHigh: 400, implausibleLow: 10, implausibleHigh: 2000, unit: "µmol/L" },
    egfr: { labelDe: "eGFR", labelEn: "eGFR", low: 60, high: 200, criticalLow: 15, criticalHigh: null, implausibleLow: 1, implausibleHigh: 250, unit: "mL/min/1.73m2" },
    potassium: { labelDe: "Kalium", labelEn: "Potassium", low: 3.5, high: 5.1, criticalLow: 2.8, criticalHigh: 6.2, implausibleLow: 1.0, implausibleHigh: 10.0, unit: "mmol/L" },
    sodium: { labelDe: "Natrium", labelEn: "Sodium", low: 135, high: 145, criticalLow: 120, criticalHigh: 160, implausibleLow: 90, implausibleHigh: 190, unit: "mmol/L" },
    tsh: { labelDe: "TSH", labelEn: "TSH", low: 0.4, high: 4.0, criticalLow: 0.05, criticalHigh: 20, implausibleLow: 0.001, implausibleHigh: 200, unit: "mU/L" },
    crp: { labelDe: "CRP", labelEn: "CRP", low: 0, high: 5, criticalLow: null, criticalHigh: 100, implausibleLow: 0, implausibleHigh: 600, unit: "mg/L" },
    bnp: { labelDe: "BNP", labelEn: "BNP", low: 0, high: 100, criticalLow: null, criticalHigh: 1000, implausibleLow: 0, implausibleHigh: 100000, unit: "pmol/L" },
  },
  aliases: {
    "hämoglobin": "hb",
    hamoglobin: "hb",
    hemoglobin: "hb",
    hb: "hb",
    thrombozyten: "platelets",
    platelets: "platelets",
    inr: "inr",
    aptt: "aptt",
    kreatinin: "creatinine",
    creatinine: "creatinine",
    egfr: "egfr",
    gfr: "egfr",
    kalium: "potassium",
    potassium: "potassium",
    natrium: "sodium",
    sodium: "sodium",
    tsh: "tsh",
    crp: "crp",
    bnp: "bnp",
  },
  consistency: {
    pauseRequiredClasses: ["DOAC", "VKA"],
    metforminEgfrMin: 45,
    egfrCode: "egfr",
  },
};

export function defaultRequirements(): RequirementsDoc {
  return structuredClone(DEFAULT_REQUIREMENTS);
}

export function defaultThresholds(): ThresholdsDoc {
  return structuredClone(DEFAULT_THRESHOLDS);
}
