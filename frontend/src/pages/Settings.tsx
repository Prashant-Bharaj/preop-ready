import { useEffect, useState } from "react";
import {
  api,
  type LabThreshold,
  type RequirementItem,
  type RequirementsDoc,
  type ThresholdsDoc,
} from "../api";
import { useI18n } from "../i18n";

const CLASSES = ["DOAC", "VKA", "ANTIPLATELET", "METFORMIN", "OTHER"];
const LAB_CODE = /^[a-z0-9_]{1,40}$/;

const EMPTY_LAB: LabThreshold = {
  labelDe: "",
  labelEn: "",
  low: null,
  high: null,
  criticalLow: null,
  criticalHigh: null,
  implausibleLow: null,
  implausibleHigh: null,
  unit: "",
};

export function Settings() {
  const { t, lang } = useI18n();
  const [requirements, setRequirements] = useState<RequirementsDoc | null>(null);
  const [thresholds, setThresholds] = useState<ThresholdsDoc | null>(null);
  const [procedure, setProcedure] = useState("TAVI");
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [newLow, setNewLow] = useState("");
  const [newHigh, setNewHigh] = useState("");

  useEffect(() => {
    Promise.all([api<RequirementsDoc>("/config/requirements"), api<ThresholdsDoc>("/config/thresholds")])
      .then(([req, thr]) => {
        setRequirements(req);
        setThresholds(thr);
        const first = Object.keys(req.procedures)[0];
        if (first) setProcedure(first);
      })
      .catch(() => setLoadError(t("error")));
  }, [t]);

  if (loadError) return <p className="text-red-800">{loadError}</p>;
  if (!requirements || !thresholds) return <p>{t("loading")}</p>;

  const requirementsDoc = requirements;
  const thresholdsDoc = thresholds;
  const rows = requirementsDoc.procedures[procedure] || [];
  const labCodes = Object.keys(thresholdsDoc.labs);

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
    const defaults: Partial<RequirementItem> =
      item === "report.DUPLEX_GROIN_PRE"
        ? { maxAgeDays: 1, timing: "pre", offsetDays: null }
        : item === "report.DUPLEX_GROIN_POST" || item === "report.GASTROSCOPY"
          ? { maxAgeDays: null, timing: "post", offsetDays: 1 }
          : item === "report.ECHO_6W"
            ? { maxAgeDays: null, timing: "post", offsetDays: 42 }
            : item === "report.ECHO_6M"
              ? { maxAgeDays: null, timing: "post", offsetDays: 183 }
              : { maxAgeDays: 7, timing: "pre", offsetDays: null };
    setRequirements((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.procedures[procedure].push({
        item,
        required: true,
        maxAgeDays: defaults.maxAgeDays ?? 7,
        mustMention: null,
        timing: defaults.timing ?? "pre",
        offsetDays: defaults.offsetDays ?? null,
      });
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

  function addLab() {
    const code = newCode.trim().toLowerCase();
    const label = newLabel.trim();
    const unit = newUnit.trim();
    if (!LAB_CODE.test(code) || !label || !unit) {
      setFormError(t("labCodeHint"));
      return;
    }
    if (thresholdsDoc.labs[code]) {
      setFormError(t("labCodeHint"));
      return;
    }
    setFormError("");
    setThresholds((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.labs[code] = {
        ...EMPTY_LAB,
        labelDe: label,
        labelEn: label,
        unit,
        low: newLow === "" ? null : Number(newLow),
        high: newHigh === "" ? null : Number(newHigh),
      };
      next.aliases[code] = code;
      next.aliases[label.toLowerCase()] = code;
      return next;
    });
    setNewCode("");
    setNewLabel("");
    setNewUnit("");
    setNewLow("");
    setNewHigh("");
  }

  function removeLab(code: string) {
    setThresholds((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      delete next.labs[code];
      next.aliases = Object.fromEntries(
        Object.entries(next.aliases).filter(([, target]) => target !== code),
      );
      return next;
    });
    setRequirements((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      const item = `lab.${code}`;
      for (const type of Object.keys(next.procedures)) {
        next.procedures[type] = next.procedures[type].filter((row) => row.item !== item);
      }
      return next;
    });
  }

  async function saveRequirements() {
    setMessage("");
    setFormError("");
    try {
      const saved = await api<RequirementsDoc>("/config/requirements", {
        method: "PUT",
        body: JSON.stringify(requirements),
      });
      setRequirements(saved);
      setMessage(t("saved"));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("error"));
    }
  }

  async function saveThresholds() {
    setMessage("");
    setFormError("");
    try {
      const saved = await api<ThresholdsDoc>("/config/thresholds", {
        method: "PUT",
        body: JSON.stringify(thresholds),
      });
      setThresholds(saved);
      // Keep procedure requirements aligned when labs were added or removed.
      const reqSaved = await api<RequirementsDoc>("/config/requirements", {
        method: "PUT",
        body: JSON.stringify(requirements),
      });
      setRequirements(reqSaved);
      setMessage(t("saved"));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("error"));
    }
  }

  return (
    <section className="space-y-8">
      <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">
        {t("settingsLead")}
      </p>
      {message && <p className="font-semibold text-emerald-800">{message}</p>}
      {formError && <p className="font-semibold text-red-800">{formError}</p>}

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="text-lg font-bold">{t("requirements")}</h2>
        <p className="mt-1 text-sm text-slate-700">{t("requirementsLead")}</p>
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
              "report.AGREEMENT",
              "report.DUPLEX_GROIN_PRE",
              "report.DUPLEX_GROIN_POST",
              "report.GASTROSCOPY",
              "report.ECHO_6W",
              "report.ECHO_6M",
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
                <th className="py-2 pr-2">{t("labCode")}</th>
                <th className="py-2 pr-2">{t("labLabel")}</th>
                <th className="py-2 pr-2">{t("unit")}</th>
                <th className="py-2 pr-2">{t("low")}</th>
                <th className="py-2 pr-2">{t("high")}</th>
                <th className="py-2 pr-2">{t("critLow")}</th>
                <th className="py-2 pr-2">{t("critHigh")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(thresholds.labs).map(([code, spec]) => (
                <tr key={code} className="border-t border-line">
                  <td className="py-2 pr-2 font-mono text-xs text-slate-600">{code}</td>
                  <td className="py-2 pr-2">
                    <input
                      className="w-36 rounded border border-line px-2 py-1"
                      value={lang === "de" ? spec.labelDe : spec.labelEn}
                      onChange={(event) =>
                        patchLab(setThresholds, code, lang === "de" ? { labelDe: event.target.value } : { labelEn: event.target.value })
                      }
                    />
                  </td>
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
                  <td className="py-2">
                    <button type="button" className="text-sm font-semibold text-red-800" onClick={() => removeLab(code)}>
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 rounded-md border border-dashed border-line bg-slate-50 p-4">
          <p className="mb-3 text-sm font-semibold">{t("addLab")}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              {t("labCode")}
              <input
                className="mt-1 block w-32 rounded border border-line px-2 py-1"
                value={newCode}
                placeholder="bnp"
                onChange={(event) => setNewCode(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {t("labLabel")}
              <input
                className="mt-1 block w-40 rounded border border-line px-2 py-1"
                value={newLabel}
                placeholder="BNP"
                onChange={(event) => setNewLabel(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {t("unit")}
              <input
                className="mt-1 block w-28 rounded border border-line px-2 py-1"
                value={newUnit}
                placeholder="pmol/L"
                onChange={(event) => setNewUnit(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {t("low")}
              <input
                className="mt-1 block w-20 rounded border border-line px-2 py-1"
                type="number"
                step="any"
                value={newLow}
                onChange={(event) => setNewLow(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {t("high")}
              <input
                className="mt-1 block w-20 rounded border border-line px-2 py-1"
                type="number"
                step="any"
                value={newHigh}
                onChange={(event) => setNewHigh(event.target.value)}
              />
            </label>
            <button type="button" onClick={addLab} className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold">
              {t("add")}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-600">{t("labCodeHint")}</p>
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
