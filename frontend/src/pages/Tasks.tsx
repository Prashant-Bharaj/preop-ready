import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, type TaskRow } from "../api";
import { useI18n } from "../i18n";

const ROLES = ["Pflege/Koordination", "Anästhesie", "Arzt"] as const;

export function Tasks() {
  const { t, lang } = useI18n();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  function load() {
    const query = showDone ? "" : "?status=OPEN";
    return api<{ tasks: TaskRow[] }>(`/tasks${query}`).then((data) => setTasks(data.tasks));
  }

  useEffect(() => {
    load().catch(() => setError(t("error")));
  }, [showDone, t]);

  async function setStatus(task: TaskRow, status: "OPEN" | "DONE") {
    await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    await load();
  }

  async function copy(task: TaskRow) {
    const text = lang === "de" ? task.textDe : task.textEn;
    await navigator.clipboard.writeText(text);
    setCopied(task.id);
    window.setTimeout(() => setCopied(""), 1500);
  }

  const roleLabel = (role: string) =>
    role === "Anästhesie" ? t("roleAnesth") : role === "Arzt" ? t("roleDoc") : t("roleCoord");

  return (
    <section>
      <p className="mb-4 max-w-3xl text-sm text-slate-700">{t("tasksLead")}</p>
      <label className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />
        {t("showDone")}
      </label>
      {error && <p className="text-red-800">{error}</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        {ROLES.map((role) => {
          const group = tasks.filter((task) => task.assignedRole === role);
          return (
            <section key={role} className="rounded-lg border border-line bg-white p-4">
              <h2 className="mb-3 text-lg font-bold">{roleLabel(role)}</h2>
              {group.length === 0 && <p className="text-sm text-slate-600">{t("noTasks")}</p>}
              <ul className="space-y-3">
                {group.map((task) => (
                  <li key={task.id} className="rounded-md border border-line p-3">
                    <p className="text-xs font-semibold text-slate-500">
                      {task.plannedTime} · {task.patientName} · {task.procedureType} · {formatDate(task.plannedDate, lang)}
                    </p>
                    <p className="mt-2 text-sm">{lang === "de" ? task.textDe : task.textEn}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => copy(task)} className="rounded-md bg-sky-800 px-3 py-1 text-sm font-semibold text-white">
                        {copied === task.id ? t("copied") : t("copy")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setStatus(task, task.status === "OPEN" ? "DONE" : "OPEN")}
                        className="rounded-md border border-line px-3 py-1 text-sm font-semibold"
                      >
                        {task.status === "OPEN" ? t("markDone") : t("reopen")}
                      </button>
                      <Link to={`/patients/${task.patientId}?procedure=${task.procedureId}`} className="px-2 py-1 text-sm font-semibold text-sky-900">
                        {t("openPatient")}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
