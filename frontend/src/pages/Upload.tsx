import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ExtractResponse, type Extraction } from "../api";
import { useI18n } from "../i18n";

interface Option {
  id: string;
  name: string;
}

export function Upload() {
  const { t } = useI18n();
  const [patients, setPatients] = useState<Option[]>([]);
  const [patientId, setPatientId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [llm, setLlm] = useState(false);

  useEffect(() => {
    Promise.all([api<{ patients: Option[] }>("/patients"), api<{ llmConfigured: boolean }>("/meta")])
      .then(([list, meta]) => {
        setPatients(list.patients);
        setPatientId(list.patients[0]?.id || "");
        setLlm(meta.llmConfigured);
      })
      .catch(() => setError(t("error")));
  }, [t]);

  async function extract(next = file) {
    if (!next) return;
    setBusy(true);
    setSaved("");
    setError("");
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

  async function useSample(name: string) {
    const response = await fetch(`/api/samples/${name}`);
    const text = await response.text();
    const sample = new File([text], name, { type: "text/plain" });
    setFile(sample);
    const hinted = name.startsWith("echo") || name.startsWith("anesthesia") ? "pat-c" : "pat-f";
    if (patients.some((item) => item.id === hinted)) setPatientId(hinted);
    await extract(sample);
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
      setSaved(patientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setBusy(false);
    }
  }

  const extraction = result?.extraction;
  const mismatch = Boolean(extraction?.patientId && patientId && extraction.patientId !== patientId);

  return (
    <section className="space-y-5">
      <p className="max-w-3xl text-sm text-slate-700">{t("uploadLead")}</p>
      <p className="text-sm font-semibold">{llm ? t("live") : t("mock")}</p>
      <div
        className="rounded-lg border-2 border-dashed border-sky-300 bg-white p-8 text-center"
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
        <p className="font-semibold">{file ? file.name : t("drop")}</p>
        <input
          className="mt-3"
          type="file"
          accept=".txt,.pdf,text/plain,application/pdf"
          onChange={(event) => {
            const chosen = event.target.files?.[0] || null;
            setFile(chosen);
            if (chosen) void extract(chosen);
          }}
        />
      </div>
      <div>
        <p className="mb-2 text-sm font-bold">{t("samples")}</p>
        <div className="flex flex-wrap gap-2">
          {["echo.txt", "xray.txt", "anesthesia.txt"].map((name) => (
            <button key={name} type="button" onClick={() => useSample(name)} className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold">
              {name}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-red-800">{error}</p>}
      {busy && <p>{t("loading")}</p>}
      {result && extraction && (
        <section className="rounded-lg border border-line bg-white p-5">
          <h2 className="text-lg font-bold">{t("preview")}</h2>
          <p className="mt-1 text-sm">{result.message}</p>
          {result.manualReviewNeeded && <p className="mt-2 font-semibold text-red-800">{t("manual")}</p>}
          <Preview extraction={extraction} />
          <label className="mt-4 block text-sm font-semibold">
            {t("fileOn")}
            <select className="ml-2 rounded-md border border-line px-2 py-2" value={patientId} onChange={(event) => setPatientId(event.target.value)}>
              {patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
            </select>
          </label>
          {mismatch && <p className="mt-2 text-sm font-semibold text-amber-900">{t("mismatch")}</p>}
          <button
            type="button"
            disabled={busy || result.manualReviewNeeded}
            onClick={confirm}
            className="mt-4 rounded-md bg-sky-800 px-4 py-3 font-bold text-white disabled:opacity-50"
          >
            {t("saveExtract")}
          </button>
          {saved && (
            <p className="mt-3">
              <Link className="font-semibold text-sky-900" to={`/patients/${saved}`}>
                {t("openPatient")}
              </Link>
            </p>
          )}
        </section>
      )}
    </section>
  );
}

function Preview({ extraction }: { extraction: Extraction }) {
  return (
    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-slate-500">Type</dt>
        <dd className="font-semibold">{extraction.reportType}</dd>
      </div>
      <div>
        <dt className="text-slate-500">Date</dt>
        <dd className="font-semibold">{extraction.date || "–"}</dd>
      </div>
      <div>
        <dt className="text-slate-500">Patient</dt>
        <dd className="font-semibold">
          {extraction.patientName || "–"} {extraction.patientId ? `(${extraction.patientId})` : ""}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500">Clearance</dt>
        <dd className="font-semibold">{extraction.clearanceStatus || "–"}</dd>
      </div>
      {extraction.conclusionText && (
        <div className="sm:col-span-2">
          <dt className="text-slate-500">Text</dt>
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
