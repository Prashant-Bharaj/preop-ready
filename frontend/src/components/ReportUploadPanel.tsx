import { useEffect, useState } from "react";
import { api, type ExtractResponse, type Extraction } from "../api";
import { useI18n } from "../i18n";

interface Props {
  patientId: string;
  patientName?: string;
  onSaved?: (patientId: string) => void;
  lead?: string;
}

const ACCEPT =
  ".txt,.pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,text/plain,application/pdf,image/png,image/jpeg,image/webp,image/gif,image/tiff";

export function ReportUploadPanel({ patientId, patientName, onSaved, lead }: Props) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [llm, setLlm] = useState(false);

  useEffect(() => {
    api<{ llmConfigured: boolean }>("/meta")
      .then((meta) => setLlm(meta.llmConfigured))
      .catch(() => setLlm(false));
  }, []);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function extract(next: File | null) {
    if (!next) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const body = new FormData();
      body.append("file", next);
      const response = await api<ExtractResponse>("/upload/extract", { method: "POST", body });
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!result || !patientId) return;
    setBusy(true);
    setError("");
    try {
      await api(`/upload/confirm`, {
        method: "POST",
        body: JSON.stringify({ patientId, extraction: result.extraction }),
      });
      onSaved?.(patientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setBusy(false);
    }
  }

  const extraction = result?.extraction;

  return (
    <div className="space-y-4">
      {lead && <p className="max-w-3xl text-sm text-muted">{lead}</p>}
      {patientName && (
        <p className="text-sm font-semibold text-ink">
          {t("patient")}: {patientName}
        </p>
      )}
      <p className="text-sm font-semibold">{llm ? t("live") : t("mock")}</p>
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
          onChange={(event) => {
            const chosen = event.target.files?.[0] || null;
            setFile(chosen);
            if (chosen) void extract(chosen);
          }}
        />
      </div>
      {error && <p className="text-danger">{error}</p>}
      {busy && <p>{t("loading")}</p>}
      {result && extraction && (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-lg font-bold">{t("preview")}</h2>
          <p className="mt-1 text-sm text-muted">{result.message}</p>
          {result.manualReviewNeeded && <p className="mt-2 font-semibold text-danger">{t("manual")}</p>}
          <Preview extraction={extraction} />
          <button
            type="button"
            disabled={busy || result.manualReviewNeeded || !patientId}
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

function Preview({ extraction }: { extraction: Extraction }) {
  return (
    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted">Type</dt>
        <dd className="font-semibold">{extraction.reportType}</dd>
      </div>
      <div>
        <dt className="text-muted">Date</dt>
        <dd className="font-semibold">{extraction.date || "–"}</dd>
      </div>
      <div>
        <dt className="text-muted">Clearance</dt>
        <dd className="font-semibold">{extraction.clearanceStatus || "–"}</dd>
      </div>
      {extraction.conclusionText && (
        <div className="sm:col-span-2">
          <dt className="text-muted">Text</dt>
          <dd>{extraction.conclusionText}</dd>
        </div>
      )}
      {extraction.findings.length > 0 && (
        <div className="sm:col-span-2">
          <ul className="space-y-1">
            {extraction.findings.map((finding) => (
              <li key={finding.name}>
                {finding.name}: {finding.value} {finding.unit}{" "}
                {finding.evidence ? `“${finding.evidence}”` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {extraction.conditions.length > 0 && <div className="sm:col-span-2">{extraction.conditions.join("; ")}</div>}
    </dl>
  );
}
