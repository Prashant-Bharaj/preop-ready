// Turn the plain text of a report (typed, PDF text layer, or OCR output) into
// a structured extraction. Rule-based only: it never guesses a value that is
// not written in the document. Anything uncertain sets manualReviewNeeded so a
// person must check and complete it before it is saved.
// Decisions (green/yellow/red) stay in the rule engine.

import type { ThresholdsDoc } from "../api";
import { addDays, clinicToday, isISODate, type ISODate } from "./dates";
import type { ExtractionInput } from "./repository";

export type Extraction = ExtractionInput;

export interface ExtractResult {
  extraction: Extraction;
  manualReviewNeeded: boolean;
  source: string;
  message: string;
}

export const REPORT_TYPES = [
  "LAB",
  "ECHO",
  "CHEST_XRAY",
  "ECG",
  "AGREEMENT",
  "ANESTHESIA",
  "DUPLEX_GROIN_PRE",
  "DUPLEX_GROIN_POST",
  "GASTROSCOPY",
  "ECHO_6W",
  "ECHO_6M",
] as const;

export function emptyExtraction(): Extraction {
  return {
    reportType: "UNKNOWN",
    date: null,
    patientId: null,
    patientName: null,
    findings: [],
    clearanceStatus: null,
    conditions: [],
    asaClass: null,
    conclusionText: null,
    manualReviewNeeded: true,
  };
}

export function manualReview(message: string, partial?: Extraction): ExtractResult {
  return {
    extraction: { ...(partial || emptyExtraction()), manualReviewNeeded: true },
    manualReviewNeeded: true,
    source: "manual",
    message,
  };
}

/** Why an extraction cannot be saved yet, or null when it is complete. */
export function reviewProblems(e: Extraction): string[] {
  const problems: string[] = [];
  if (!REPORT_TYPES.includes(e.reportType as (typeof REPORT_TYPES)[number])) problems.push("type");
  if (!e.date || !isISODate(e.date)) problems.push("date");
  if (e.reportType === "LAB" && !e.findings.some((f) => f.value !== null)) problems.push("values");
  if (e.reportType === "ANESTHESIA" && !e.clearanceStatus) problems.push("clearance");
  return problems;
}

// ------------------------------------------------------- demo fixtures
// Same synthetic fixtures the offline backend used (backend/samples/*.json),
// matched by the SYNTH-* marker in the sample documents.

interface Fixture extends Omit<Extraction, "date" | "manualReviewNeeded"> {
  dateOffsetDays: number;
}

const FIXTURES: Record<string, Fixture> = {
  "SYNTH-LABS-001": {
    reportType: "LAB",
    dateOffsetDays: -1,
    patientId: "pat-c",
    patientName: "Testperson C",
    findings: [
      { name: "Hämoglobin", value: 13.4, unit: "g/dL", evidence: "Hämoglobin 13.4 g/dL" },
      { name: "Thrombozyten", value: 240, unit: "10^9/L", evidence: "Thrombozyten 240 10^9/L" },
      { name: "INR", value: 1.0, unit: "ratio", evidence: "INR 1.0" },
      { name: "aPTT", value: 31, unit: "s", evidence: "aPTT 31 s" },
      { name: "Kreatinin", value: 80, unit: "µmol/L", evidence: "Kreatinin 80 µmol/L" },
      { name: "eGFR", value: 78, unit: "mL/min/1.73m2", evidence: "eGFR 78 mL/min/1.73m2" },
      { name: "Kalium", value: 4.1, unit: "mmol/L", evidence: "Kalium 4.1 mmol/L" },
      { name: "Natrium", value: 139, unit: "mmol/L", evidence: "Natrium 139 mmol/L" },
      { name: "TSH", value: 1.6, unit: "mU/L", evidence: "TSH 1.6 mU/L" },
      { name: "CRP", value: 1.2, unit: "mg/L", evidence: "CRP 1.2 mg/L" },
      { name: "BNP", value: 48, unit: "pmol/L", evidence: "BNP 48 pmol/L" },
    ],
    clearanceStatus: null,
    conditions: [],
    asaClass: null,
    conclusionText: "Synthetisches Laborblatt. BNP 48 pmol/L. Kalium 4.1 mmol/L.",
  },
  "SYNTH-ECHO-001": {
    reportType: "ECHO",
    dateOffsetDays: -4,
    patientId: "pat-c",
    patientName: "Testperson C",
    findings: [{ name: "LVEF", value: 58, unit: "%", evidence: "LVEF 58 %" }],
    clearanceStatus: null,
    conditions: [],
    asaClass: null,
    conclusionText: "TEE mit guter Schallqualität. Hochgradige Aortenklappenstenose. LVEF 58 %. Kein Perikarderguss.",
  },
  "SYNTH-ECG-001": {
    reportType: "ECG",
    dateOffsetDays: -1,
    patientId: "pat-b",
    patientName: "Testperson B",
    findings: [{ name: "Herzfrequenz", value: 72, unit: "/min", evidence: "Frequenz 72/min" }],
    clearanceStatus: null,
    conditions: [],
    asaClass: null,
    conclusionText: "Sinusrhythmus. Frequenz 72/min. Keine Ischämiezeichen.",
  },
  "SYNTH-XRAY-001": {
    reportType: "CHEST_XRAY",
    dateOffsetDays: -3,
    patientId: "pat-f",
    patientName: "Testperson F",
    findings: [],
    clearanceStatus: null,
    conditions: [],
    asaClass: null,
    conclusionText: "Keine pneumonischen Infiltrate. Herzgröße im Normbereich. Kein Pleuraerguss.",
  },
  "SYNTH-ANEST-001": {
    reportType: "ANESTHESIA",
    dateOffsetDays: -1,
    patientId: "pat-c",
    patientName: "Testperson C",
    findings: [],
    clearanceStatus: "GRANTED",
    conditions: [],
    asaClass: "ASA III",
    conclusionText: "Freigabe erteilt. Auflagen: keine. Narkosefähigkeit für den geplanten Eingriff gegeben.",
  },
  "SYNTH-AGREE-001": {
    reportType: "AGREEMENT",
    dateOffsetDays: -2,
    patientId: "pat-c",
    patientName: "Testperson C",
    findings: [],
    clearanceStatus: null,
    conditions: [],
    asaClass: null,
    conclusionText:
      "Einverständniserklärung zum geplanten Eingriff. Patientenunterschrift liegt vor. Aufklärung ist erfolgt.",
  },
};

function fixtureFor(text: string): Extraction | null {
  for (const [marker, fixture] of Object.entries(FIXTURES)) {
    if (text.includes(marker)) {
      const { dateOffsetDays, ...rest } = structuredClone(fixture);
      return { ...rest, date: addDays(clinicToday(), dateOffsetDays), manualReviewNeeded: false };
    }
  }
  return null;
}

// -------------------------------------------------------------- parser

export function extractFromText(
  rawText: string,
  thresholds: ThresholdsDoc,
  origin: "text" | "pdf" | "ocr",
): ExtractResult {
  const text = normalise(rawText);
  if (!text.trim()) return manualReview("No text could be read from the document");

  const fixture = fixtureFor(text);
  if (fixture) {
    return {
      extraction: fixture,
      manualReviewNeeded: false,
      source: "mock",
      message: "Synthetic demo document recognised – values taken from the demo fixture",
    };
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const extraction = emptyExtraction();
  extraction.patientId = matchGroup(text, /Patienten-?\s?ID\s*[:.]?\s*([A-Za-z0-9_-]{1,64})/i);
  const name = matchGroup(text, /^\s*Patient(?:in)?\s*[:]\s*(.{1,200})$/im);
  extraction.patientName = name ? name.trim() : null;
  extraction.date = findDate(text);
  extraction.reportType = detectType(text, lines, thresholds);

  if (extraction.reportType === "LAB") {
    extraction.findings = labFindings(lines, thresholds);
  } else if (extraction.reportType === "ANESTHESIA") {
    const asa = text.match(/ASA[\s-]*(?:Klassifikation|Klasse)?\s*[:]?\s*(?:ASA\s*)?(VI|IV|V|III|II|I|[1-6])\b/i);
    extraction.asaClass = asa ? `ASA ${romanise(asa[1])}` : null;
    const { status, conditions } = clearanceStatus(text);
    extraction.clearanceStatus = status;
    extraction.conditions = conditions;
  } else if (extraction.reportType.startsWith("ECHO")) {
    const lvef = text.match(/LVEF\s*[:=]?\s*(?:ca\.?\s*)?(\d{1,2}(?:[.,]\d)?)\s*%/i);
    if (lvef) {
      extraction.findings.push({ name: "LVEF", value: toNumber(lvef[1]), unit: "%", evidence: lvef[0].trim() });
    }
  } else if (extraction.reportType === "ECG") {
    const hr = text.match(/(?:Herz)?frequenz\s*[:=]?\s*(\d{2,3})\s*\/\s*min/i);
    if (hr) {
      extraction.findings.push({ name: "Herzfrequenz", value: toNumber(hr[1]), unit: "/min", evidence: hr[0].trim() });
    }
  }
  extraction.conclusionText = conclusion(lines);

  const problems = reviewProblems(extraction);
  extraction.manualReviewNeeded = problems.length > 0;
  const how = origin === "ocr" ? "Read locally with OCR" : origin === "pdf" ? "Read from the PDF text" : "Read from the text file";
  return {
    extraction,
    manualReviewNeeded: extraction.manualReviewNeeded,
    source: origin === "ocr" ? "ocr" : "parser",
    message: problems.length
      ? `${how}. Please check and complete: ${problems.join(", ")}.`
      : `${how}. Please check every value against the document before saving.`,
  };
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2012-\u2015]/g, "–")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ");
}

function matchGroup(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}

function findDate(text: string): ISODate | null {
  // Prefer a date that follows a date label; otherwise the first valid date.
  const labelled = text.match(
    /(?:Datum|Befunddatum|Untersuchungsdatum|Abnahme|Date)\s*[:]?\s*(\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})/i,
  );
  const candidates = labelled ? [labelled[1]] : [];
  for (const m of text.matchAll(/\b(\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})\b/g)) candidates.push(m[1]);
  for (const c of candidates) {
    const iso = c.includes(".")
      ? (() => {
          const [d, m, y] = c.split(".");
          return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        })()
      : c;
    if (isISODate(iso)) return iso;
  }
  return null;
}

function detectType(text: string, lines: string[], thresholds: ThresholdsDoc): string {
  const t = text.toLowerCase();
  if (/an[äa]sthesie|narkose|asa[\s-]*(klass|[ivx1-6])/.test(t)) return "ANESTHESIA";
  if (/einverst[äa]ndnis|patientenunterschrift|einwilligung/.test(t)) return "AGREEMENT";
  if (labFindings(lines, thresholds).length >= 2) return "LAB";
  if (/duplex/.test(t)) {
    return /postinterventionell|nach dem eingriff|post-?op/.test(t) ? "DUPLEX_GROIN_POST" : "DUPLEX_GROIN_PRE";
  }
  if (/gastroskopie|ögd|oegd/.test(t)) return "GASTROSCOPY";
  if (/echo/.test(t) && /6\s*wochen|sechs wochen/.test(t)) return "ECHO_6W";
  if (/echo/.test(t) && /6\s*monate|sechs monate/.test(t)) return "ECHO_6M";
  if (/echokardiographie|echokardiografie|\btee\b|\btte\b|lvef/.test(t)) return "ECHO";
  if (/r[öo]ntgen|thorax|x-?ray/.test(t)) return "CHEST_XRAY";
  if (/\bekg\b|\becg\b|sinusrhythmus/.test(t)) return "ECG";
  return "UNKNOWN";
}

const LAB_LINE = /^([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß-]*(?: [A-Za-zÄÖÜäöüß-]+)?)\s*[:=]?\s*([<>]?\s*-?\d+(?:[.,]\d+)?)\s*(\S+)?/;

function labFindings(lines: string[], thresholds: ThresholdsDoc): Extraction["findings"] {
  const aliases = Object.fromEntries(
    Object.entries(thresholds.aliases || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const labs = thresholds.labs || {};
  const found: Extraction["findings"] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const m = line.match(LAB_LINE);
    if (!m) continue;
    const label = m[1].trim();
    const code = aliases[label.toLowerCase()];
    if (!code || seen.has(code)) continue;
    if (/[<>]/.test(m[2])) continue; // "<5" is not a measured value — leave it to the reviewer
    const value = toNumber(m[2]);
    if (value === null) continue;
    let unit = m[3] && !/^[(\[]/.test(m[3]) ? m[3].replace(/[;,]$/, "") : "";
    // Dimensionless results (e.g. INR) are often printed without a unit.
    if (!unit && labs[code]?.unit === "ratio") unit = "ratio";
    seen.add(code);
    found.push({ name: label, value, unit: unit || null, evidence: line.slice(0, 200) });
  }
  return found;
}

function clearanceStatus(text: string): { status: string | null; conditions: string[] } {
  const t = text.toLowerCase();
  const conditionsMatch = text.match(/Auflagen?\s*[:]\s*(.+)/i);
  const rawConditions = conditionsMatch ? conditionsMatch[1].trim().replace(/\.$/, "") : "";
  const conditions =
    rawConditions && !/^(keine?|none|–|-)\.?$/i.test(rawConditions)
      ? rawConditions
          .split(/;|,(?![^(]*\))/)
          .map((c) => c.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];
  if (/nicht erteilt|keine freigabe|nicht freigegeben|abgelehnt|verweigert/.test(t)) return { status: "MISSING", conditions };
  if (conditions.length || /bedingt|unter auflagen|mit auflagen/.test(t)) {
    return { status: "CONDITIONAL", conditions };
  }
  if (/freigabe erteilt|freigegeben|narkosef[äa]hig/.test(t)) return { status: "GRANTED", conditions };
  return { status: null, conditions };
}

const ADMIN_LINE = /^(patient(?:in)?|patienten-?\s?id|kennung|geb(?:oren|\.)|universit|klinik|station|seite|page)\b/i;

function conclusion(lines: string[]): string | null {
  const body = lines.filter((l) => !ADMIN_LINE.test(l)).join(" ");
  const text = body.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 4000) : null;
}

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function romanise(token: string): string {
  const map: Record<string, string> = { "1": "I", "2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI" };
  return map[token] || token.toUpperCase();
}
