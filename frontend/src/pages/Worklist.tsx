import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Meta, type ProcedureRow, type Readiness } from "../api";
import CountUp from "../components/reactbits/CountUp";
import ShinyText from "../components/reactbits/ShinyText";
import SpotlightCard from "../components/reactbits/SpotlightCard";
import { useTheme } from "../theme";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";

type WindowKey = "tomorrow" | "today" | "horizon";

interface CreatedCase {
  patientId: string;
  procedureId: string;
  patientName: string;
  plannedDate: string;
}

export function Worklist() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>("tomorrow");
  const [rows, setRows] = useState<ProcedureRow[]>([]);
  const [procedure, setProcedure] = useState("all");
  const [status, setStatus] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    birthDate: "1950-01-01",
    sex: "female",
    ward: "Station Kardiologie 1",
    procedureType: "TAVI",
    plannedDate: "",
    plannedTime: "14:00",
    operator: "Dr. Test Operateur",
  });

  const selectedDate = meta ? meta[windowKey] : "";
  const maxPlannedDate = useMemo(() => {
    if (!meta?.today) return "";
    const day = new Date(`${meta.today}T12:00:00`);
    day.setDate(day.getDate() + 60);
    return day.toISOString().slice(0, 10);
  }, [meta?.today]);

  useEffect(() => {
    let cancelled = false;
    api<Meta>("/meta")
      .then((data) => {
        if (!cancelled) setMeta(data);
      })
      .catch(() => {
        if (!cancelled) setError(t("error"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!selectedDate) return;
    let cancelled = false;
    setLoading(true);
    api<{ procedures: ProcedureRow[] }>(`/procedures?date=${selectedDate}`)
      .then((data) => {
        if (cancelled) return;
        setRows(data.procedures);
        setError("");
      })
      .catch(() => {
        if (!cancelled) setError(t("error"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, t]);

  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (procedure !== "all" && row.procedureType !== procedure) return false;
        if (status !== "all" && row.readiness !== status) return false;
        return true;
      }),
    [rows, procedure, status],
  );

  const types = Array.from(new Set(rows.map((row) => row.procedureType)));

  async function reload(date = selectedDate) {
    const data = await api<{ procedures: ProcedureRow[] }>(`/procedures?date=${date}`);
    setRows(data.procedures);
  }

  async function checkAll() {
    await api("/check/all", { method: "POST" });
    await reload();
  }

  function openAddForm() {
    setAdding((open) => {
      if (!open) {
        setForm((current) => ({
          ...current,
          plannedDate: current.plannedDate || selectedDate,
        }));
      }
      return !open;
    });
  }

  async function createCase(event: FormEvent) {
    event.preventDefault();
    const plannedDate = form.plannedDate || selectedDate;
    if (!plannedDate || !form.name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const response = await api<CreatedCase>("/patients", {
        method: "POST",
        body: JSON.stringify({ ...form, name: form.name.trim(), plannedDate }),
      });
      setAdding(false);
      setForm((current) => ({ ...current, name: "", plannedDate: "" }));
      navigate(
        `/patients/${response.patientId}?procedure=${response.procedureId}&upload=1`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setSaving(false);
    }
  }

  const counts = {
    RED: rows.filter((row) => row.readiness === "RED").length,
    YELLOW: rows.filter((row) => row.readiness === "YELLOW").length,
    GREEN: rows.filter((row) => row.readiness === "GREEN").length,
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.14em]">
            <ShinyText text="Clinical command center" color={resolvedTheme === "dark" ? "#4ac2bb" : "#0c696e"} shineColor={resolvedTheme === "dark" ? "#e6fffc" : "#5fd6cc"} speed={3} delay={4} trigger="loop" />
          </p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">{t("navWorklist")}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["horizon", "tomorrow", "today"] as WindowKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setWindowKey(key)}
              className={`rounded-lg border px-4 py-2 text-sm font-bold ${
                windowKey === key ? "border-accent bg-accent text-white shadow-sm shadow-accent/25" : "border-line bg-surface text-muted hover:border-accent/40 hover:text-accent-strong"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={openAddForm} className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white shadow-sm shadow-accent/30 hover:bg-accent-strong">
            {t("addPatient")}
          </button>
          <button type="button" onClick={checkAll} className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:border-accent/40">
            {t("checkAll")}
          </button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {(["RED", "YELLOW", "GREEN"] as Readiness[]).map((readiness) => (
          <SpotlightCard
            key={readiness}
            theme={resolvedTheme}
            spotlightColor={readiness === "RED" ? "#e5484d" : readiness === "YELLOW" ? "#f0b03b" : "#30a46c"}
            intensity={0.35}
            spotlightSize={180}
            className="rounded-xl p-0"
            style={{ "--spotlight-card-surface": "rgb(var(--surface))", "--spotlight-card-border": "rgb(var(--line))" } as CSSProperties}
          >
          <button
            type="button"
            onClick={() => setStatus(status === readiness ? "all" : readiness)}
            className={`group w-full rounded-xl border p-4 text-left ${
              readiness === "RED"
                ? "border-danger/25 bg-danger/10"
                : readiness === "YELLOW"
                  ? "border-warning/25 bg-warning/10"
                  : "border-success/25 bg-success/10"
            } ${status === readiness ? "ring-2 ring-accent/40" : "hover:-translate-y-0.5"}`}
          >
            <span className="text-xs font-bold uppercase tracking-wide text-muted">{readiness === "RED" ? t("red") : readiness === "YELLOW" ? t("yellow") : t("green")}</span>
            <CountUp
              key={`${readiness}-${counts[readiness]}`}
              to={counts[readiness]}
              duration={0.6}
              className="mt-1 block text-3xl font-extrabold tabular-nums text-ink"
            />
            <span className="text-sm text-muted">{t("procedure")}</span>
          </button>
          </SpotlightCard>
        ))}
      </div>
      {adding && (
        <form onSubmit={createCase} className="grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-sm sm:grid-cols-2">
          <label className="text-sm font-semibold">
            {t("patient")}
            <input
              required
              maxLength={80}
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label className="text-sm font-semibold">
            {t("born")}
            <input
              required
              type="date"
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.birthDate}
              onChange={(event) => setForm({ ...form, birthDate: event.target.value })}
            />
          </label>
          <label className="text-sm font-semibold">
            {t("sex")}
            <select
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.sex}
              onChange={(event) => setForm({ ...form, sex: event.target.value })}
            >
              <option value="female">{t("female")}</option>
              <option value="male">{t("male")}</option>
            </select>
          </label>
          <label className="text-sm font-semibold">
            {t("ward")}
            <input
              required
              maxLength={80}
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.ward}
              onChange={(event) => setForm({ ...form, ward: event.target.value })}
            />
          </label>
          <label className="text-sm font-semibold">
            {t("procedure")}
            <select
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.procedureType}
              onChange={(event) => setForm({ ...form, procedureType: event.target.value })}
            >
              <option>TAVI</option>
              <option>M-TEER</option>
            </select>
          </label>
          <label className="text-sm font-semibold">
            {t("date")}
            <input
              required
              type="date"
              min={meta?.today}
              max={maxPlannedDate || undefined}
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.plannedDate || selectedDate}
              onChange={(event) => setForm({ ...form, plannedDate: event.target.value })}
            />
          </label>
          <label className="text-sm font-semibold">
            {t("time")}
            <input
              required
              type="time"
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.plannedTime}
              onChange={(event) => setForm({ ...form, plannedTime: event.target.value })}
            />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">
            {t("operator")}
            <input
              required
              maxLength={80}
              className="mt-1 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-ink"
              value={form.operator}
              onChange={(event) => setForm({ ...form, operator: event.target.value })}
            />
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              {t("savePatient")}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink">
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap gap-3 rounded-xl border border-line bg-surface-raised p-4">
        <label className="text-sm font-semibold">
          {t("procedure")}
          <select
            className="ml-2 rounded-lg border border-line bg-surface px-2 py-2 text-ink"
            value={procedure}
            onChange={(event) => setProcedure(event.target.value)}
          >
            <option value="all">{t("allProcedures")}</option>
            {types.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold">
          {t("status")}
          <select
            className="ml-2 rounded-lg border border-line bg-surface px-2 py-2 text-ink"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">{t("allStatuses")}</option>
            {(["RED", "YELLOW", "GREEN"] as Readiness[]).map((item) => (
              <option key={item} value={item}>
                {item === "RED" ? t("red") : item === "YELLOW" ? t("yellow") : t("green")}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 font-semibold text-danger">{error}</p>}
      {loading ? (
        <p>{t("loading")}</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-8 text-center text-muted">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-sm">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-accent-soft text-xs uppercase tracking-wide text-accent-strong">
              <tr>
                <th className="px-4 py-3">{t("time")}</th>
                <th className="px-4 py-3">{t("patient")}</th>
                <th className="px-4 py-3">{t("procedure")}</th>
                <th className="px-4 py-3">{t("status")}</th>
                <th className="px-4 py-3">{t("issues")}</th>
                <th className="px-4 py-3">{t("clearance")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id} className="border-t border-line transition-colors hover:bg-surface-raised">
                  <td className="px-4 py-3 font-semibold">{row.time}</td>
                  <td className="px-4 py-3">
                    <Link className="font-semibold text-accent-strong underline-offset-2 hover:underline" to={`/patients/${row.patientId}?procedure=${row.id}`}>
                      {row.patientName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{row.procedureType}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.readiness} />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      className="text-lg font-extrabold text-accent-strong underline-offset-2 hover:underline"
                      to={`/patients/${row.patientId}?procedure=${row.id}`}
                    >
                      {row.openIssues}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {row.clearance === "GRANTED" ? t("GRANTED") : row.clearance === "CONDITIONAL" ? t("CONDITIONAL") : t("MISSING")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
