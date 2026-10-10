// Parser check against the synthetic report texts in ../context/*.txt and the
// expected values in ../backend/samples/*.json. SYNTH markers are stripped so
// the real rule-based parser is exercised (not the demo fixture shortcut).
// Usage (from frontend/): npx tsx checks/parser.check.ts

import { readFileSync } from "node:fs";
import { defaultThresholds } from "../src/local/configDefaults";
import { extractFromText } from "../src/local/parseReport";

const names = ["labs", "echo", "ecg", "xray", "anesthesia", "agreement"];
let failures = 0;
for (const name of names) {
  const text = readFileSync(`../context/${name}.txt`, "utf8").replace(/Kennung: SYNTH-[A-Z]+-\d+/g, "");
  // OCR'd documents usually carry a date; add one so it is exercised too.
  const result = extractFromText(`${text}\nDatum: 08.10.2026`, defaultThresholds(), "ocr");
  const expected = JSON.parse(readFileSync(`../backend/samples/${name}.json`, "utf8"));
  const e = result.extraction;
  const problems: string[] = [];
  if (e.reportType !== expected.reportType) problems.push(`type ${e.reportType} != ${expected.reportType}`);
  if (e.patientId !== expected.patientId) problems.push(`patientId ${e.patientId}`);
  if (e.patientName !== expected.patientName) problems.push(`patientName ${e.patientName}`);
  if (e.date !== "2026-10-08") problems.push(`date ${e.date}`);
  if (e.clearanceStatus !== expected.clearanceStatus) problems.push(`clearance ${e.clearanceStatus}`);
  if (e.asaClass !== expected.asaClass) problems.push(`asa ${e.asaClass}`);
  for (const want of expected.findings as { name: string; value: number; unit: string }[]) {
    const got = e.findings.find((f) => f.name === want.name);
    if (!got || got.value !== want.value || got.unit !== want.unit) {
      problems.push(`finding ${want.name}: ${JSON.stringify(got)}`);
    }
  }
  if (e.findings.length !== expected.findings.length) problems.push(`findings count ${e.findings.length}`);
  for (const must of ["Patientenunterschrift", "TEE"]) {
    if (expected.conclusionText?.includes(must) && !e.conclusionText?.includes(must)) problems.push(`text lacks ${must}`);
  }
  if (result.manualReviewNeeded) problems.push(`manual review: ${result.message}`);
  if (problems.length) failures += 1;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${name}${problems.length ? ": " + problems.join("; ") : ""}`);
}

// Without a date the parser must refuse to auto-save.
const undated = extractFromText(readFileSync("../context/ecg.txt", "utf8").replace(/SYNTH/g, "X"), defaultThresholds(), "ocr");
const blocked = undated.manualReviewNeeded && undated.extraction.date === null;
console.log(`${blocked ? "ok  " : "FAIL"} undated document requires manual review`);
if (!blocked) failures += 1;

// Garbage must never become a saveable extraction.
const junk = extractFromText("lorem ipsum 12 34", defaultThresholds(), "ocr");
console.log(`${junk.manualReviewNeeded ? "ok  " : "FAIL"} unrecognised text requires manual review`);
if (!junk.manualReviewNeeded) failures += 1;

process.exit(failures ? 1 : 0);
