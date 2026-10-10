import { useEffect, useState } from "react";
import { api, type ExtractResponse, type Extraction } from "../api";
import { useI18n } from "../i18n";
import { REPORT_TYPES, reviewProblems } from "../local/parseReport";
import { setExtractProgress } from "../local/progress";

interface Props {
  patientId: string;
  patientName?: string;
  onSaved?: (patientId: string) => void;
  lead?: string;
}

const ACCEPT =
  ".txt,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,text/plain,application/pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp";

const input =
  "w-full rounded-lg border border-line bg-surface-raised px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none";

export function ReportUploadPanel({ patientId, patientName, onSaved, lead }: Props) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [draft, setDraft] = useState<Extraction | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ message: string; ratio?: number } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => setExtractProgress(null), []);

  async function extract(next: File | null) {
    if (!next) return;
    setBusy(true);
    setError("");
    setResult(null);
    setDraft(null);
    setProgress(null);
    setExtractProgress((message, ratio) => setProgress({ message, ratio }));
    try {
      const body = new FormData();
      body.append("file", next);
      const response = await api<ExtractResponse>("/upload/extract", { method: "POST", body });
      setResult(response);
      setDraft(response.extraction);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setExtractProgress(null);
      setProgress(null);
      setBusy(false);
    }
  }

  const problems = draft ? reviewProblems(draft) : ["type"];
  const mismatch = Boolean(draft?.patientId && draft.patientId !== patientId);

  async function confirm() {
    if (!draft || !patientId || problems.length) return;
    setBusy(true);
    setError("");
    try {
      // The person has reviewed (and possibly corrected) every field.
      const reviewed: Extraction = {
        ...draft,
        findings: draft.findings.filter((f) => f.name.trim()),
        manualReviewNeeded: false,
      };
      await api(`/upload/confirm`, {
        method: "POST",
        body: JSON.stringify({ patientId, extraction: reviewed }),
      });
      onSaved?.(patientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {lead && <p className="max-w-3xl text-sm text-muted">{lead}</p>}
      {patientName && (
        <p className="text-sm font-semibold text-ink">
          {t("patient")}: {patientName}
        </p>
      )}
      <p className="text-sm font-semibold">{t("localOcr")}</p>
      <div
        className="rounded-xl border-2 border-dashed border-accent/40 bg-surface p-8 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = event.dataTransfer.files[0];
          if (dropped) {
            setFile(dropped);
            void extract(dropped);
          }
        }}
      >
        <p className="font-semibold text-ink">{file ? file.name : t("drop")}</p>
        {previewUrl && (
          <img
            src={previewUrl}
            alt=""
            className="mx-auto mt-3 max-h-48 rounded-lg border border-line object-contain"
          />
        )}
        <input
          className="mt-3"
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(event) => {
            const chosen = event.target.files?.[0] || null;
            setFile(chosen);
            if (chosen) void extract(chosen);
          }}
        />
      </div>
      {error && <p className="text-danger">{error}</p>}
      {busy && (
        <div className="space-y-1" role="status" aria-live="polite">
          <p>{progress ? t("ocrLoading") : t("loading")}</p>
          {progress && (
            <>
              <p className="text-xs text-muted">
                {progress.message}
                {progress.ratio !== undefined ? ` · ${Math.round(progress.ratio * 100)} %` : ""}
              </p>
              <p className="text-xs text-muted">{t("ocrFirst")}</p>
            </>
          )}
        </div>
      )}
      {result && draft && (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-lg font-bold">{t("preview")}</h2>
          <p className="mt-1 text-sm text-muted">{result.message}</p>
          <p className="mt-1 text-sm text-muted">{t("reviewLead")}</p>
          {mismatch && (
            <p className="mt-2 font-semibold text-danger">
              {t("patientMismatch")} ({draft.patientId} ≠ {patientId}).
            </p>
          )}
          <ReviewForm draft={draft} onChange={setDraft} />
          {problems.length > 0 && <p className="mt-3 font-semibold text-danger">{t("reviewBlocked")}</p>}
          <button
            type="button"
            disabled={busy || problems.length > 0 || !patientId}
            onClick={confirm}
            className="mt-4 rounded-lg bg-accent px-4 py-3 font-bold text-white disabled:opacity-50"
          >
            {t("saveExtract")}
          </button>
        </section>
      )}
    </div>
  );
}

function ReviewForm({ draft, onChange }: { draft: Extraction; onChange: (next: Extraction) => void }) {
  const { t } = useI18n();
  const set = <K extends keyof Extraction>(key: K, value: Extraction[K]) => onChange({ ...draft, [key]: value });
  const setFinding = (index: number, patch: Partial<Extraction["findings"][number]>) =>
    set(
      "findings",
      draft.findings.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );

  return (
    <div className="mt-4 space-y-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-muted">{t("reportType")}</span>
          <select className={input} value={draft.reportType} onChange={(e) => set("reportType", e.target.value)}>
            <option value="UNKNOWN">{t("chooseType")}</option>
            {REPORT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-muted">{t("date")}</span>
          <input
            className={input}
            type="date"
            value={draft.date || ""}
            onChange={(e) => set("date", e.target.value || null)}
          />
        </label>
        {draft.reportType === "ANESTHESIA" && (
          <label className="space-y-1">
            <span className="text-muted">{t("clearance")}</span>
            <select
              className={input}
              value={draft.clearanceStatus || ""}
              onChange={(e) => set("clearanceStatus", e.target.value || null)}
            >
              <option value="">{t("chooseType")}</option>
              <option value="GRANTED">{t("GRANTED")}</option>
              <option value="CONDITIONAL">{t("CONDITIONAL")}</option>
              <option value="MISSING">{t("MISSING")}</option>
            </select>
          </label>
        )}
      </div>

      {draft.reportType === "ANESTHESIA" && (
        <label className="block space-y-1">
          <span className="text-muted">{t("conditions")}</span>
          <input
            className={input}
            value={draft.conditions.join("; ")}
            maxLength={500}
            onChange={(e) =>
              set(
                "conditions",
                e.target.value
                  .split(";")
                  .map((c) => c.trim())
                  .filter(Boolean)
                  .slice(0, 20),
              )
            }
          />
        </label>
      )}

      {(draft.findings.length > 0 || draft.reportType === "LAB") && (
        <div className="space-y-2">
          <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2 text-xs text-muted">
            <span>{t("findingName")}</span>
            <span>{t("value")}</span>
            <span>{t("unit")}</span>
            <span />
          </div>
          {draft.findings.map((f, index) => (
            <div key={index} className="space-y-1">
              <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2">
                <input
                  className={input}
                  value={f.name}
                  maxLength={200}
                  onChange={(e) => setFinding(index, { name: e.target.value })}
                />
                <input
                  className={input}
                  inputMode="decimal"
                  value={f.value ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value.replace(",", ".").trim();
                    const value = raw === "" ? null : Number(raw);
                    setFinding(index, { value: value === null || Number.isFinite(value) ? value : f.value });
                  }}
                />
                <input
                  className={input}
                  value={f.unit ?? ""}
                  maxLength={40}
                  onChange={(e) => setFinding(index, { unit: e.target.value || null })}
                />
                <button
                  type="button"
                  className="rounded-lg px-2 text-xs font-semibold text-danger hover:bg-danger/10"
                  onClick={() => set("findings", draft.findings.filter((_, i) => i !== index))}
                >
                  {t("remove")}
                </button>
              </div>
              {f.evidence && <p className="text-xs text-muted">“{f.evidence}”</p>}
            </div>
          ))}
          {draft.findings.length < 40 && (
            <button
              type="button"
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold hover:bg-accent-soft"
              onClick={() =>
                // Manually typed values cite themselves as evidence ("manuell erfasst").
                set("findings", [...draft.findings, { name: "", value: null, unit: null, evidence: "manuell erfasst" }])
              }
            >
              {t("addValue")}
            </button>
          )}
        </div>
      )}

      <label className="block space-y-1">
        <span className="text-muted">{t("conclusion")}</span>
        <textarea
          className={`${input} min-h-24`}
          value={draft.conclusionText || ""}
          maxLength={4000}
          onChange={(e) => set("conclusionText", e.target.value || null)}
        />
      </label>
    </div>
  );
}
