import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  formatDate,
  formatStamp,
  type Meta,
  type PatientDetail as PatientPayload,
  type TaskRow,
} from "../api";
import { ReportUploadPanel } from "../components/ReportUploadPanel";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";

export function PatientDetail() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const { t, lang } = useI18n();
  const [data, setData] = useState<PatientPayload | null>(null);
  const [openTasks, setOpenTasks] = useState<TaskRow[]>([]);
  const [userName, setUserName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyItem, setBusyItem] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadKey, setUploadKey] = useState(0);
  const [uploadNotice, setUploadNotice] = useState("");

  const load = useCallback(
    async (attempt = 0): Promise<void> => {
      try {
        const [detail, meta] = await Promise.all([
          api<PatientPayload>(`/patients/${id}`),
          api<Meta>("/meta").catch(() => null),
        ]);
        setError("");
        setData(detail);
        setOpenTasks(detail.openTasks ?? []);
        if (meta) setUserName(meta.user.name);
      } catch (err) {
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
          return load(attempt + 1);
        }
        throw err;
      }
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    setError("");
    load()
      .catch(() => {
        if (!cancelled) setError(t("error"));
      });
    return () => {
      cancelled = true;
    };
  }, [id, load, t]);

  useEffect(() => {
    if (params.get("upload") === "1") {
      setShowUpload(true);
    }
  }, [params]);

  if (!data && error) {
    return (
      <section className="space-y-4">
        <Link to="/" className="text-sm font-semibold text-sky-900">
          {t("back")}
        </Link>
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">{error}</p>
        <button
          type="button"
          className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold"
          onClick={() => {
            setError("");
            void load().catch(() => setError(t("error")));
          }}
        >
          {t("recheck")}
        </button>
      </section>
    );
  }
  if (!data) return <p>{t("loading")}</p>;

  const requested = params.get("procedure");
  const procedure = data.procedures.find((item) => item.id === requested) || data.procedures[0];
  if (!procedure) return <p>{t("empty")}</p>;

  const procedureTasks = openTasks.filter((task) => task.procedureId === procedure.id);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api(`/procedures/${procedure.id}/confirm`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setBusy(false);
    }
  }

  async function recheck() {
    setBusy(true);
    setError("");
    try {
      await api(`/check/${procedure.id}`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setBusy(false);
    }
  }

  async function markDone(task: TaskRow) {
    setBusy(true);
    setBusyItem(task.id);
    setError("");
    setOpenTasks((current) => current.filter((row) => row.id !== task.id));
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "DONE" }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
      setBusyItem("");
    }
  }

  async function markChecklistItemDone(itemKey: string) {
    setBusy(true);
    setBusyItem(itemKey);
    setError("");
    setOpenTasks((current) => current.filter((task) => task.item !== itemKey));
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        procedures: current.procedures.map((proc) => {
          if (proc.id !== procedure.id) return proc;
          return {
            ...proc,
            openIssues: Math.max(0, proc.openIssues - 1),
            checklist: proc.checklist.map((item) =>
              item.item === itemKey
                ? { ...item, state: "complete" as const, detailDe: "", detailEn: "" }
                : item,
            ),
          };
        }),
      };
    });
    try {
      await api(`/procedures/${procedure.id}/checklist-done`, {
        method: "POST",
        body: JSON.stringify({ itemKey }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
      setBusyItem("");
    }
  }

  const sex = data.patient.sex === "female" ? t("female") : t("male");

  return (
    <section className="space-y-6">
      <Link to="/" className="text-sm font-semibold text-sky-900">
        {t("back")}
      </Link>
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">{error}</p>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-line bg-white p-5">
        <div>
          <h1 className="text-2xl font-bold">{data.patient.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {t("born")} {formatDate(data.patient.birthDate, lang)} · {sex} · {data.patient.ward}
          </p>
          <p className="mt-2 text-lg font-semibold">
            {procedure.procedureType} · {formatDate(procedure.plannedDate, lang)} {procedure.plannedTime}
          </p>
          <p className="text-sm text-slate-600">
            {t("operator")}: {procedure.operator}
          </p>
        </div>
        <div className="text-right">
          <StatusBadge status={procedure.readiness} large />
          <p className="mt-2 text-sm">
            {procedure.confirmedAt
              ? `${t("confirmed")}: ${procedure.confirmedBy} · ${formatStamp(procedure.confirmedAt, lang)}`
              : t("notConfirmed")}
          </p>
        </div>
      </header>

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="text-lg font-bold">
          {t("openTasksFor")} {data.patient.name}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{t("tasksLead")}</p>
        {procedureTasks.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">{t("noTasks")}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {procedureTasks.map((task) => (
              <li key={task.id} className="rounded-lg border border-line bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-500">
                  {task.assignedRole} · {task.procedureType} · {task.plannedTime}
                </p>
                <p className="mt-2 text-sm">{lang === "de" ? task.textDe : task.textEn}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void markDone(task)}
                  className="mt-3 rounded-md border border-line bg-white px-3 py-1 text-sm font-semibold disabled:opacity-50"
                >
                  {busyItem === task.id ? t("loading") : t("markDone")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-line bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{t("checklist")}</h2>
          <button type="button" onClick={recheck} disabled={busy} className="rounded-md border border-line px-3 py-1 text-sm font-semibold">
            {t("recheck")}
          </button>
        </div>
        <ul className="divide-y divide-line">
          {procedure.checklist.map((item) => (
              <li key={item.item} id={item.sourceRef || item.item} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{lang === "de" ? item.labelDe : item.labelEn}</p>
                  <p className="text-sm text-slate-700">{lang === "de" ? item.detailDe : item.detailEn}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatePill state={item.state} />
                  {item.state !== "complete" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void markChecklistItemDone(item.item)}
                      className="rounded-md border border-line bg-white px-3 py-1 text-sm font-semibold disabled:opacity-50"
                    >
                      {busyItem === item.item ? t("loading") : t("markDone")}
                    </button>
                  )}
                </div>
              </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-line bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{t("reports")}</h2>
          <button
            type="button"
            onClick={() => {
              setShowUpload((open) => !open);
              setUploadNotice("");
            }}
            className="rounded-md border border-line px-3 py-1 text-sm font-semibold"
          >
            {showUpload ? t("cancel") : t("uploadReport")}
          </button>
        </div>
        {uploadNotice && <p className="mb-3 font-semibold text-emerald-800">{uploadNotice}</p>}
        {showUpload && (
          <div className="mb-4 rounded-md border border-dashed border-sky-300 bg-sky-50/40 p-4">
            <ReportUploadPanel
              key={uploadKey}
              lead={t("uploadOnCase")}
              patientId={data.patient.id}
              patientName={data.patient.name}
              onSaved={async () => {
                setUploadNotice(t("uploadSaved"));
                setUploadKey((value) => value + 1);
                setShowUpload(false);
                await load();
              }}
            />
          </div>
        )}
        {data.reports.length === 0 && !showUpload && <p>{t("noReports")}</p>}
        <div className="space-y-4">
          {data.reports.map((report) => (
            <article key={report.id} id={report.id} className="rounded-md border border-line p-4">
              <p className="font-bold">
                {report.type} · {report.date ? formatDate(report.date, lang) : "–"}
              </p>
              <p className="mt-2 text-sm">{report.conclusionText}</p>
              {report.evidence && (
                <p className="mt-2 text-sm text-slate-600">
                  {t("evidence")}: “{report.evidence}”
                </p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                {t("source")}: {report.sourceFile}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="mb-3 text-lg font-bold">{t("labs")}</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-3">{t("labs")}</th>
                <th className="py-2 pr-3">{t("value")}</th>
                <th className="py-2 pr-3">{t("range")}</th>
                <th className="py-2 pr-3">{t("date")}</th>
                <th className="py-2">{t("source")}</th>
              </tr>
            </thead>
            <tbody>
              {data.labs.map((lab) => (
                <tr
                  key={lab.id}
                  id={lab.id}
                  className={
                    lab.flag === "critical" ? "bg-red-50" : lab.flag === "warning" ? "bg-amber-50" : ""
                  }
                >
                  <td className="py-2 pr-3 font-semibold">{lang === "de" ? lab.labelDe : lab.labelEn}</td>
                  <td className="py-2 pr-3">
                    {lab.value} {lab.unit}
                  </td>
                  <td className="py-2 pr-3">
                    {lab.low ?? "–"} – {lab.high ?? "–"} {lab.expectedUnit || ""}
                  </td>
                  <td className="py-2 pr-3">{formatDate(lab.effectiveDate, lang)}</td>
                  <td className="py-2">{lab.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-line bg-white p-5">
          <h2 className="mb-3 text-lg font-bold">{t("clearance")}</h2>
          {!data.clearance && <p>{t("noClearance")}</p>}
          {data.clearance && (
            <div>
              <p className="text-lg font-bold">
                {data.clearance.status === "GRANTED"
                  ? t("GRANTED")
                  : data.clearance.status === "CONDITIONAL"
                    ? t("CONDITIONAL")
                    : t("MISSING")}
              </p>
              <p className="text-sm">
                {data.clearance.date ? formatDate(data.clearance.date, lang) : "–"} · {data.clearance.asaClass || "–"}
              </p>
              <p className="mt-2 text-sm">
                {t("conditions")}: {data.clearance.conditions.length ? data.clearance.conditions.join("; ") : t("none")}
              </p>
              {data.clearance.anesthetist && <p className="text-sm">{data.clearance.anesthetist}</p>}
            </div>
          )}
        </section>
        <section className="rounded-lg border border-line bg-white p-5">
          <h2 className="mb-3 text-lg font-bold">{t("medications")}</h2>
          {data.medications.length === 0 && <p>{t("noMeds")}</p>}
          <ul className="space-y-2">
            {data.medications.map((med) => (
              <li key={med.id} id={med.id}>
                <span className="font-semibold">{med.name}</span> · {med.class} ·{" "}
                {med.status === "PAUSED" ? t("paused") : t("active")}
                {med.pausedSince ? ` ${formatDate(med.pausedSince, lang)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="mb-3 text-lg font-bold">{t("findings")}</h2>
        {procedure.findings.length === 0 && <p>{t("complete")}</p>}
        <ul className="space-y-3">
          {procedure.findings.map((finding) => (
            <li key={`${finding.item}-${finding.sourceRef}-${finding.category}`} className="rounded-md border border-line p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                {finding.category} · {finding.severity}
              </p>
              <p className="mt-1">{lang === "de" ? finding.messageDe : finding.messageEn}</p>
              {finding.sourceRef && (
                <a className="text-sm font-semibold text-sky-900" href={`#${finding.sourceRef}`}>
                  {t("source")}: {finding.sourceRef}
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-sky-200 bg-sky-50 p-5">
        <h2 className="text-lg font-bold">{t("confirmSection")}</h2>
        <p className="mt-2 text-sm">{t("confirmHint")}</p>
        {procedure.readiness !== "GREEN" && !procedure.confirmedAt && (
          <p className="mt-2 text-sm font-semibold">{t("confirmWarn")}</p>
        )}
        {procedure.confirmedAt ? (
          <p className="mt-3 text-sm font-semibold text-emerald-900">
            {t("confirmDone")}: {procedure.confirmedBy} · {formatStamp(procedure.confirmedAt, lang)}
          </p>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className="mt-3 rounded-md bg-sky-800 px-4 py-3 text-base font-bold text-white disabled:opacity-50"
          >
            {t("confirm")} {t("asUser")} {userName}
          </button>
        )}
      </section>
    </section>
  );
}

function StatePill({ state }: { state: string }) {
  const { t } = useI18n();
  const label =
    state === "complete"
      ? t("complete")
      : state === "missing"
        ? t("missing")
        : state === "outdated"
          ? t("outdated")
          : state === "critical"
            ? t("critical")
            : t("warning");
  const tone =
    state === "complete"
      ? "bg-emerald-100 text-emerald-900"
      : state === "critical" || state === "missing"
        ? "bg-red-100 text-red-900"
        : "bg-amber-100 text-amber-950";
  return <span className={`rounded-full px-3 py-1 text-sm font-bold ${tone}`}>{label}</span>;
}
