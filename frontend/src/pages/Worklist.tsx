import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Meta, type ProcedureRow, type Readiness } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";

type WindowKey = "tomorrow" | "today" | "horizon";

export function Worklist() {
  const { t } = useI18n();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>("tomorrow");
  const [rows, setRows] = useState<ProcedureRow[]>([]);
  const [procedure, setProcedure] = useState("all");
  const [status, setStatus] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const selectedDate = meta ? meta[windowKey] : "";

  useEffect(() => {
    api<Meta>("/meta")
      .then(setMeta)
      .catch(() => setError(t("error")));
  }, [t]);

  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    api<{ procedures: ProcedureRow[] }>(`/procedures?date=${selectedDate}`)
      .then((data) => {
        setRows(data.procedures);
        setError("");
      })
      .catch(() => setError(t("error")))
      .finally(() => setLoading(false));
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

  async function checkAll() {
    await api("/check/all", { method: "POST" });
    const data = await api<{ procedures: ProcedureRow[] }>(`/procedures?date=${selectedDate}`);
    setRows(data.procedures);
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["horizon", "tomorrow", "today"] as WindowKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setWindowKey(key)}
              className={`rounded-md border px-4 py-2 text-sm font-bold ${
                windowKey === key ? "border-sky-800 bg-sky-800 text-white" : "border-line bg-white"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <button type="button" onClick={checkAll} className="rounded-md border border-line bg-white px-4 py-2 text-sm font-semibold">
          {t("checkAll")}
        </button>
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="text-sm font-semibold">
          {t("procedure")}
          <select
            className="ml-2 rounded-md border border-line bg-white px-2 py-2"
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
            className="ml-2 rounded-md border border-line bg-white px-2 py-2"
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
      {error && <p className="mb-3 text-red-800">{error}</p>}
      {loading ? (
        <p>{t("loading")}</p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-line bg-white p-6">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-sky-50 text-xs uppercase tracking-wide text-slate-600">
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
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-3 font-semibold">{row.time}</td>
                  <td className="px-4 py-3">
                    <Link className="font-semibold text-sky-900 underline-offset-2 hover:underline" to={`/patients/${row.patientId}?procedure=${row.id}`}>
                      {row.patientName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{row.procedureType}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.readiness} />
                  </td>
                  <td className="px-4 py-3 text-lg font-bold">{row.openIssues}</td>
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
