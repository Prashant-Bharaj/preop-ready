import { useEffect, useState } from "react";
import { api, type RequirementItem, type RequirementsDoc, type ThresholdsDoc } from "../api";
import { useI18n } from "../i18n";

const CLASSES = ["DOAC", "VKA", "ANTIPLATELET", "METFORMIN", "OTHER"];

export function Settings() {
  const { t, lang } = useI18n();
  const [requirements, setRequirements] = useState<RequirementsDoc | null>(null);
  const [thresholds, setThresholds] = useState<ThresholdsDoc | null>(null);
  const [procedure, setProcedure] = useState("TAVI");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api<RequirementsDoc>("/config/requirements"), api<ThresholdsDoc>("/config/thresholds")])
      .then(([req, thr]) => {
        setRequirements(req);
        setThresholds(thr);
        const first = Object.keys(req.procedures)[0];
        if (first) setProcedure(first);
      })
      .catch(() => setError(t("error")));
  }, [t]);

  if (error) return <p className="text-red-800">{error}</p>;
  if (!requirements || !thresholds) return <p>{t("loading")}</p>;

  const rows = requirements.procedures[procedure] || [];
  const labCodes = Object.keys(thresholds.labs);

  function updateRow(index: number, patch: Partial<RequirementItem>) {
    setRequirements((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.procedures[procedure][index] = { ...next.procedures[procedure][index], ...patch };
      return next;
    });
  }

  function addItem(item: string) {
    if (!item || rows.some((row) => row.item === item)) return;
    setRequirements((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.procedures[procedure].push({ item, required: true, maxAgeDays: 7, mustMention: null });
      return next;
    });
  }

  function removeItem(index: number) {
    setRequirements((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.procedures[procedure].splice(index, 1);
      return next;
    });
  }

  async function saveRequirements() {
    setMessage("");
    const saved = await api<RequirementsDoc>("/config/requirements", {
      method: "PUT",
      body: JSON.stringify(requirements),
    });
    setRequirements(saved);
    setMessage(t("saved"));
  }

  async function saveThresholds() {
    setMessage("");
    const saved = await api<ThresholdsDoc>("/config/thresholds", {
      method: "PUT",
      body: JSON.stringify(thresholds),
    });
    setThresholds(saved);
    setMessage(t("saved"));
  }

  return (
    <section className="space-y-8">
      <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">
        {t("settingsLead")}
      </p>
      {message && <p className="font-semibold text-emerald-800">{message}</p>}

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="text-lg font-bold">{t("requirements")}</h2>
        <div className="mt-3 flex gap-2">
          {Object.keys(requirements.procedures).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setProcedure(type)}
              className={`rounded-md px-3 py-1 text-sm font-bold ${procedure === type ? "bg-sky-800 text-white" : "bg-slate-100"}`}
            >
              {type}
            </button>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 pr-3">{t("required")}</th>
                <th className="py-2 pr-3">{t("maxAge")}</th>
                <th className="py-2 pr-3">{t("mention")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.item} className="border-t border-line">
                  <td className="py-2 pr-3 font-semibold">{labelFor(row.item, requirements, thresholds, lang)}</td>
                  <td className="py-2 pr-3">
                    <input type="checkbox" checked={row.required} onChange={(event) => updateRow(index, { required: event.target.checked })} />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      className="w-24 rounded border border-line px-2 py-1"
                      type="number"
                      min={0}
                      value={row.maxAgeDays ?? ""}
                      onChange={(event) =>
                        updateRow(index, { maxAgeDays: event.target.value === "" ? null : Number(event.target.value) })
                      }
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      className="w-24 rounded border border-line px-2 py-1"
                      value={row.mustMention || ""}
                      onChange={(event) => updateRow(index, { mustMention: event.target.value || null })}
                    />
                  </td>
                  <td className="py-2">
                    <button type="button" className="text-sm font-semibold text-red-800" onClick={() => removeItem(index)}>
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <AddMenu
            label={t("add")}
            options={[
              ...labCodes.map((code) => `lab.${code}`),
              "report.ECHO",
              "report.CHEST_XRAY",
              "report.ECG",
              "clearance.anesthesia",
            ].filter((item) => !rows.some((row) => row.item === item))}
            onAdd={addItem}
          />
          <button type="button" onClick={saveRequirements} className="rounded-md bg-sky-800 px-4 py-2 text-sm font-bold text-white">
            {t("save")}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="text-lg font-bold">{t("thresholds")}</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-2">Code</th>
                <th className="py-2 pr-2">{t("unit")}</th>
                <th className="py-2 pr-2">{t("low")}</th>
                <th className="py-2 pr-2">{t("high")}</th>
                <th className="py-2 pr-2">{t("critLow")}</th>
                <th className="py-2">{t("critHigh")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(thresholds.labs).map(([code, spec]) => (
                <tr key={code} className="border-t border-line">
                  <td className="py-2 pr-2 font-semibold">{lang === "de" ? spec.labelDe : spec.labelEn}</td>
                  <td className="py-2 pr-2">
                    <input
                      className="w-28 rounded border border-line px-2 py-1"
                      value={spec.unit}
                      onChange={(event) => patchLab(setThresholds, code, { unit: event.target.value })}
                    />
                  </td>
                  {(["low", "high", "criticalLow", "criticalHigh"] as const).map((field) => (
                    <td key={field} className="py-2 pr-2">
                      <input
                        className="w-20 rounded border border-line px-2 py-1"
                        type="number"
                        step="any"
                        value={spec[field] ?? ""}
                        onChange={(event) =>
                          patchLab(setThresholds, code, {
                            [field]: event.target.value === "" ? null : Number(event.target.value),
                          })
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <fieldset className="mt-4">
          <legend className="text-sm font-semibold">{t("pauseClasses")}</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {CLASSES.map((name) => (
              <label key={name} className="text-sm">
                <input
                  type="checkbox"
                  className="mr-1"
                  checked={thresholds.consistency.pauseRequiredClasses.includes(name)}
                  onChange={(event) => {
                    setThresholds((current) => {
                      if (!current) return current;
                      const next = structuredClone(current);
                      const set = new Set(next.consistency.pauseRequiredClasses);
                      if (event.target.checked) set.add(name);
                      else set.delete(name);
                      next.consistency.pauseRequiredClasses = Array.from(set);
                      return next;
                    });
                  }}
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 block text-sm font-semibold">
          {t("metformin")}
          <input
            className="ml-2 w-24 rounded border border-line px-2 py-1"
            type="number"
            value={thresholds.consistency.metforminEgfrMin ?? ""}
            onChange={(event) =>
              setThresholds((current) => {
                if (!current) return current;
                const next = structuredClone(current);
                next.consistency.metforminEgfrMin = event.target.value === "" ? null : Number(event.target.value);
                return next;
              })
            }
          />
        </label>
        <button type="button" onClick={saveThresholds} className="mt-4 rounded-md bg-sky-800 px-4 py-2 text-sm font-bold text-white">
          {t("save")}
        </button>
      </section>
    </section>
  );
}

function labelFor(item: string, requirements: RequirementsDoc, thresholds: ThresholdsDoc, lang: "de" | "en") {
  if (item.startsWith("lab.")) {
    const spec = thresholds.labs[item.slice(4)];
    if (spec) return lang === "de" ? spec.labelDe : spec.labelEn;
  }
  const pair = requirements.labels[item];
  if (pair) return lang === "de" ? pair.de : pair.en;
  return item;
}

function patchLab(
  setThresholds: (value: ThresholdsDoc | ((current: ThresholdsDoc | null) => ThresholdsDoc | null)) => void,
  code: string,
  patch: Partial<ThresholdsDoc["labs"][string]>,
) {
  setThresholds((current) => {
    if (!current) return current;
    const next = structuredClone(current);
    next.labs[code] = { ...next.labs[code], ...patch };
    return next;
  });
}

function AddMenu({ options, onAdd, label }: { options: string[]; onAdd: (item: string) => void; label: string }) {
  const [value, setValue] = useState(options[0] || "");
  useEffect(() => setValue(options[0] || ""), [options]);
  if (options.length === 0) return null;
  return (
    <div className="flex gap-2">
      <select className="rounded-md border border-line px-2 py-2 text-sm" value={value} onChange={(event) => setValue(event.target.value)}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <button type="button" className="rounded-md border border-line px-3 py-2 text-sm font-semibold" onClick={() => onAdd(value)}>
        {label}
      </button>
    </div>
  );
}
