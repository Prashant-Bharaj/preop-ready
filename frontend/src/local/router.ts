// In-browser replacement for the FastAPI routes (backend/app/api.py).
// Pages keep calling api("/path", init) unchanged; this module answers from
// IndexedDB instead of the network. Validation mirrors backend/app/schemas.py.

import type { RequirementsDoc, ThresholdsDoc } from "../api";
import { DISCLAIMER } from "./configDefaults";
import { addDays, clinicToday, isISODate } from "./dates";
import { extractFromText, manualReview, reviewProblems, type ExtractResult } from "./parseReport";
import { ocrImage, pdfText } from "./ocr";
import { reportExtractProgress } from "./progress";
import {
  LOCAL_ACTOR,
  confirmProcedure,
  createCase,
  getPatient,
  listPatientOptions,
  listProcedures,
  listTasks,
  markChecklistItemDone,
  putConfig,
  runCheck,
  runCheckAll,
  saveExtraction,
  seededDb,
  tomorrow,
  updateTaskStatus,
  type ExtractionInput,
  type NewCase,
} from "./repository";
import { readSnapshot, transact } from "./store";

export class LocalApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const badRequest = (m: string) => new LocalApiError(m, 400);
const notFound = (m: string) => new LocalApiError(m, 404);
const unprocessable = (m: string) => new LocalApiError(m, 422);

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM = /^(lab|report|clearance)\.[A-Za-z0-9_-]{1,40}$/;
const CODE = /^[a-z0-9_]{1,40}$/;
const PROC = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_UPLOAD = 8_000_000;

const tx = <T>(work: Parameters<typeof transact<T>>[0]) => transact(work, () => seededDb());

export { setExtractProgress } from "./progress";

export async function handle(path: string, init?: RequestInit): Promise<unknown> {
  const method = (init?.method || "GET").toUpperCase();
  const url = new URL(path, "http://local");
  const parts = url.pathname.split("/").filter(Boolean);
  const q = url.searchParams;
  const route = `${method} /${parts.map((p, i) => (isParam(parts[0], i, p) ? ":" : p)).join("/")}`;
  const param = parts[1] ? decodeURIComponent(parts[1]) : "";

  switch (route) {
    case "GET /health":
      return { status: "ok" };

    case "GET /meta": {
      const today = clinicToday();
      return {
        today,
        tomorrow: tomorrow(today),
        horizon: addDays(today, 14),
        llmConfigured: false,
        localOnly: true,
        user: { name: LOCAL_ACTOR.name, userId: LOCAL_ACTOR.userId },
        disclaimer: DISCLAIMER,
      };
    }

    case "GET /procedures": {
      const raw = q.get("date");
      if (raw && !isISODate(raw)) throw badRequest("Date must be YYYY-MM-DD");
      const on = raw || tomorrow();
      return tx((db) => ({ date: on, procedures: listProcedures(db, on) }));
    }

    case "GET /patients":
      return tx((db) => ({ patients: listPatientOptions(db) }));

    case "POST /patients": {
      const body = validateNewCase(json(init));
      return tx((db) => {
        const created = createCase(db, body, LOCAL_ACTOR);
        if (!created) throw badRequest("The case could not be added");
        return created;
      });
    }

    case "GET /patients/:": {
      checkId(param);
      return tx((db) => {
        const detail = getPatient(db, param);
        if (!detail) throw notFound("Patient was not found");
        return detail;
      });
    }

    case "POST /check/all":
      return tx((db) => ({ results: runCheckAll(db) }));

    case "POST /check/:": {
      checkId(param);
      return tx((db) => {
        const result = runCheck(db, param);
        if (!result) throw notFound("Procedure was not found");
        return result;
      });
    }

    case "GET /tasks": {
      const status = q.get("status");
      const role = q.get("role");
      const patientId = q.get("patientId");
      if (status && status !== "OPEN" && status !== "DONE") throw badRequest("Status must be OPEN or DONE");
      if (role && !["Pflege/Koordination", "Anästhesie", "Arzt"].includes(role)) throw badRequest("Unknown role");
      if (patientId) checkId(patientId);
      return tx((db) => ({ tasks: listTasks(db, status, role, patientId) }));
    }

    case "PATCH /tasks/:": {
      checkId(param);
      const status = (json(init) as { status?: unknown }).status;
      if (status !== "OPEN" && status !== "DONE") throw badRequest("Invalid request");
      return tx((db) => {
        const updated = updateTaskStatus(db, param, status, LOCAL_ACTOR);
        if (!updated) throw notFound("Task was not found");
        return updated;
      });
    }

    case "POST /procedures/:/checklist-done": {
      checkId(param);
      const itemKey = (json(init) as { itemKey?: unknown }).itemKey;
      if (typeof itemKey !== "string" || !ITEM.test(itemKey)) throw badRequest("Invalid request");
      return tx((db) => {
        const result = markChecklistItemDone(db, param, itemKey, LOCAL_ACTOR);
        if (!result) throw notFound("Procedure was not found");
        return result;
      });
    }

    case "POST /procedures/:/confirm": {
      checkId(param);
      return tx((db) => {
        const result = confirmProcedure(db, param, LOCAL_ACTOR);
        if (!result) throw notFound("Procedure was not found");
        return result;
      });
    }

    case "GET /config/requirements":
      return tx((db) => db.config.requirements);
    case "PUT /config/requirements": {
      const doc = validateRequirements(json(init));
      return tx((db) => putConfig(db, "requirements", doc, LOCAL_ACTOR));
    }
    case "GET /config/thresholds":
      return tx((db) => db.config.thresholds);
    case "PUT /config/thresholds": {
      const doc = validateThresholds(json(init));
      return tx((db) => putConfig(db, "thresholds", doc, LOCAL_ACTOR));
    }

    case "POST /upload/extract":
      return extractUpload(init?.body);

    case "POST /upload/confirm": {
      const body = json(init) as { patientId?: unknown; extraction?: unknown };
      if (typeof body.patientId !== "string" || !ID.test(body.patientId)) throw badRequest("Invalid request");
      const extraction = validateExtraction(body.extraction);
      if (extraction.manualReviewNeeded || reviewProblems(extraction).length) {
        throw unprocessable("Manual review is still required");
      }
      const patientId = body.patientId;
      return tx((db) => {
        const stored = saveExtraction(db, patientId, extraction, "upload");
        if (!stored) throw notFound("Patient was not found");
        db.audit.push({
          id: crypto.randomUUID(),
          eventType: "upload.confirm",
          actorId: LOCAL_ACTOR.userId,
          actorName: LOCAL_ACTOR.name,
          entityType: "patient",
          entityId: patientId,
          detail: { reportType: extraction.reportType },
          createdAt: new Date().toISOString(),
        });
        return stored;
      });
    }
  }
  throw notFound("Not found");
}

// Second path segment is an id for these resources.
function isParam(resource: string, index: number, segment: string): boolean {
  if (index !== 1) return false;
  if (resource === "check") return segment !== "all";
  return ["patients", "tasks", "procedures"].includes(resource);
}

// ------------------------------------------------------------ extraction

async function extractUpload(body: BodyInit | null | undefined): Promise<ExtractResult> {
  if (!(body instanceof FormData)) throw badRequest("Invalid request");
  const file = body.get("file");
  if (!(file instanceof File)) throw badRequest("Invalid request");
  if (file.size > MAX_UPLOAD) throw badRequest("File is too large");
  if (file.size === 0) throw badRequest("File is empty");

  const snapshot = await readSnapshot();
  const thresholds = snapshot?.config.thresholds ?? seededDb().config.thresholds;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const progress = reportExtractProgress;

  try {
    if (isPdf(file.name, head)) {
      const { text, usedOcr } = await pdfText(file, progress);
      if (!text.trim()) throw unprocessable("No text could be read from the file");
      return extractFromText(text, thresholds, usedOcr ? "ocr" : "pdf");
    }
    if (isImage(file.name, head)) {
      const text = await ocrImage(file, progress);
      if (!text.trim()) return manualReview("OCR could not read any text from this image");
      return extractFromText(text, thresholds, "ocr");
    }
    const text = await file.text();
    if (!text.trim()) throw unprocessable("No text could be read from the file");
    return extractFromText(text, thresholds, "text");
  } catch (err) {
    if (err instanceof LocalApiError) throw err;
    return manualReview("The document could not be read on this device");
  }
}

function isPdf(name: string, head: Uint8Array): boolean {
  return name.toLowerCase().endsWith(".pdf") || String.fromCharCode(...head.slice(0, 4)) === "%PDF";
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp"];

function isImage(name: string, h: Uint8Array): boolean {
  const lower = name.toLowerCase();
  if (IMAGE_EXTS.some((ext) => lower.endsWith(ext))) return true;
  const ascii = String.fromCharCode(...h);
  if (h[0] === 0x89 && ascii.slice(1, 4) === "PNG") return true;
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return true;
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return true;
  return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
}

// ------------------------------------------------------------ validation

function json(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") throw badRequest("Invalid request");
  try {
    return JSON.parse(init.body);
  } catch {
    throw badRequest("Invalid request");
  }
}

function checkId(value: string) {
  if (!ID.test(value)) throw badRequest("Invalid id");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optNum = (v: unknown) => v === null || v === undefined || (typeof v === "number" && Number.isFinite(v));
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

function plainText(value: unknown): string {
  if (typeof value !== "string") throw badRequest("Invalid request");
  const cleaned = value.split(/\s+/).filter(Boolean).join(" ");
  if (!cleaned || cleaned.length > 80 || /[<>]/.test(cleaned)) throw badRequest("Invalid request");
  return cleaned;
}

function validateNewCase(raw: unknown): NewCase {
  if (!isObj(raw)) throw badRequest("Invalid request");
  const { birthDate, plannedDate, plannedTime, sex, procedureType } = raw;
  if (typeof birthDate !== "string" || !isISODate(birthDate)) throw badRequest("Invalid request");
  if (typeof plannedDate !== "string" || !isISODate(plannedDate)) throw badRequest("Invalid request");
  const time = typeof plannedTime === "string" ? plannedTime.match(/^(\d{2}):(\d{2})$/) : null;
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw badRequest("Invalid request");
  if (sex !== "female" && sex !== "male") throw badRequest("Invalid request");
  if (typeof procedureType !== "string" || !PROC.test(procedureType)) throw badRequest("Invalid request");
  return {
    name: plainText(raw.name),
    ward: plainText(raw.ward),
    operator: plainText(raw.operator),
    birthDate,
    plannedDate,
    plannedTime: plannedTime as string,
    sex,
    procedureType,
  };
}

function validateRequirements(raw: unknown): RequirementsDoc {
  if (!isObj(raw) || !str(raw.disclaimer, 200) || !isObj(raw.labels) || !isObj(raw.procedures)) {
    throw badRequest("Invalid request");
  }
  const labels: RequirementsDoc["labels"] = {};
  for (const [key, pair] of Object.entries(raw.labels)) {
    if (!isObj(pair) || !str(pair.de, 80) || !str(pair.en, 80)) throw badRequest("Invalid request");
    labels[key] = { de: pair.de as string, en: pair.en as string };
  }
  const procedures: RequirementsDoc["procedures"] = {};
  for (const [type, items] of Object.entries(raw.procedures)) {
    if (!PROC.test(type) || !Array.isArray(items)) throw badRequest("Invalid request");
    procedures[type] = items.map((it) => {
      if (!isObj(it) || typeof it.item !== "string" || !ITEM.test(it.item)) throw badRequest("Invalid request");
      const intIn = (v: unknown, max: number) =>
        v === null || v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max);
      if (!intIn(it.maxAgeDays, 3650) || !intIn(it.offsetDays, 400)) throw badRequest("Invalid request");
      if (it.mustMention !== null && it.mustMention !== undefined && !str(it.mustMention, 40)) {
        throw badRequest("Invalid request");
      }
      const timing = typeof it.timing === "string" && it.timing.trim() ? it.timing.trim().toLowerCase() : "pre";
      if (timing !== "pre" && timing !== "post") throw badRequest("Invalid request");
      return {
        item: it.item,
        required: it.required === undefined ? true : Boolean(it.required),
        maxAgeDays: (it.maxAgeDays as number | null | undefined) ?? null,
        mustMention: (it.mustMention as string | null | undefined) ?? null,
        timing,
        offsetDays: (it.offsetDays as number | null | undefined) ?? null,
      };
    });
  }
  return { disclaimer: raw.disclaimer as string, labels, procedures };
}

function validateThresholds(raw: unknown): ThresholdsDoc {
  if (!isObj(raw) || !str(raw.disclaimer, 200) || !isObj(raw.labs) || !isObj(raw.aliases) || !isObj(raw.consistency)) {
    throw badRequest("Invalid request");
  }
  const labs: ThresholdsDoc["labs"] = {};
  for (const [code, spec] of Object.entries(raw.labs)) {
    if (!CODE.test(code) || !isObj(spec) || !str(spec.labelDe, 80) || !str(spec.labelEn, 80) || !str(spec.unit, 40)) {
      throw badRequest("Invalid request");
    }
    const keys = ["low", "high", "criticalLow", "criticalHigh", "implausibleLow", "implausibleHigh"] as const;
    if (!keys.every((k) => optNum(spec[k]))) throw badRequest("Invalid request");
    labs[code] = {
      labelDe: spec.labelDe as string,
      labelEn: spec.labelEn as string,
      unit: spec.unit as string,
      low: (spec.low as number | null) ?? null,
      high: (spec.high as number | null) ?? null,
      criticalLow: (spec.criticalLow as number | null) ?? null,
      criticalHigh: (spec.criticalHigh as number | null) ?? null,
      implausibleLow: (spec.implausibleLow as number | null) ?? null,
      implausibleHigh: (spec.implausibleHigh as number | null) ?? null,
    };
  }
  const aliases: Record<string, string> = {};
  for (const [key, target] of Object.entries(raw.aliases)) {
    if (key.length > 80 || typeof target !== "string" || !CODE.test(target)) throw badRequest("Invalid request");
    aliases[key.toLowerCase()] = target;
  }
  const c = raw.consistency;
  const allowed = new Set(["DOAC", "VKA", "ANTIPLATELET", "METFORMIN", "OTHER"]);
  const classes = Array.isArray(c.pauseRequiredClasses) ? c.pauseRequiredClasses : [];
  if (classes.length > 8) throw badRequest("Invalid request");
  const pauseRequiredClasses = classes.map((x) => {
    const token = String(x).trim().toUpperCase();
    if (!allowed.has(token)) throw badRequest("Invalid request");
    return token;
  });
  const egfrMin = c.metforminEgfrMin;
  if (!optNum(egfrMin) || (typeof egfrMin === "number" && (egfrMin < 0 || egfrMin > 200))) {
    throw badRequest("Invalid request");
  }
  const egfrCode = c.egfrCode === undefined ? "egfr" : c.egfrCode;
  if (!str(egfrCode, 40)) throw badRequest("Invalid request");
  return {
    disclaimer: raw.disclaimer as string,
    labs,
    aliases,
    consistency: {
      pauseRequiredClasses,
      metforminEgfrMin: (egfrMin as number | null | undefined) ?? null,
      egfrCode: egfrCode as string,
    },
  };
}

const EXTRACT_TYPES = new Set([
  "CHEST_XRAY",
  "ECHO",
  "ECG",
  "LAB",
  "ANESTHESIA",
  "AGREEMENT",
  "DUPLEX_GROIN_PRE",
  "DUPLEX_GROIN_POST",
  "GASTROSCOPY",
  "ECHO_6W",
  "ECHO_6M",
  "UNKNOWN",
]);

function validateExtraction(raw: unknown): ExtractionInput {
  if (!isObj(raw)) throw badRequest("Invalid request");
  const bad = () => badRequest("Invalid request");
  if (typeof raw.reportType !== "string" || !EXTRACT_TYPES.has(raw.reportType)) throw bad();
  const date = raw.date ?? null;
  if (date !== null && (typeof date !== "string" || !isISODate(date))) throw bad();
  let patientId = raw.patientId ?? null;
  if (patientId === "") patientId = null;
  if (patientId !== null && (typeof patientId !== "string" || !ID.test(patientId))) throw bad();
  const patientName = raw.patientName ?? null;
  if (patientName !== null && !str(patientName, 200)) throw bad();
  const findings = raw.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 40) throw bad();
  const cleanFindings = findings.map((f) => {
    if (!isObj(f) || !str(f.name, 200) || !optNum(f.value)) throw bad();
    const unit = f.unit ?? null;
    const evidence = f.evidence ?? null;
    if (unit !== null && !str(unit, 40)) throw bad();
    if (evidence !== null && !str(evidence, 500)) throw bad();
    // Every value must point at the text it came from.
    if (f.value !== null && f.value !== undefined && !(typeof evidence === "string" && evidence.trim())) throw bad();
    return {
      name: f.name as string,
      value: (f.value as number | null | undefined) ?? null,
      unit: unit as string | null,
      evidence: evidence as string | null,
    };
  });
  const status = raw.clearanceStatus ?? null;
  if (status !== null && !["GRANTED", "CONDITIONAL", "MISSING"].includes(status as string)) throw bad();
  const conditions = raw.conditions ?? [];
  if (!Array.isArray(conditions) || conditions.length > 20 || !conditions.every((c) => str(c, 500))) throw bad();
  const asaClass = raw.asaClass ?? null;
  if (asaClass !== null && !str(asaClass, 20)) throw bad();
  const conclusionText = raw.conclusionText ?? null;
  if (conclusionText !== null && !str(conclusionText, 4000)) throw bad();
  return {
    reportType: raw.reportType,
    date: date as string | null,
    patientId: patientId as string | null,
    patientName: patientName as string | null,
    findings: cleanFindings,
    clearanceStatus: status as string | null,
    conditions: conditions as string[],
    asaClass: asaClass as string | null,
    conclusionText: conclusionText as string | null,
    manualReviewNeeded: Boolean(raw.manualReviewNeeded),
  };
}
