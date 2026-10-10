import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { backupFileName, exportBackup, importBackup, resetToDemo } from "../local/backup";

/** Backup / restore of the browser-local dataset. */
export function DataPanel() {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(work: () => Promise<void>, okText: string) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setNotice({ ok: true, text: okText });
      // Other pages hold state loaded from the old dataset; reload to start clean.
      setTimeout(() => window.location.reload(), 800);
    } catch {
      setNotice({ ok: false, text: t("importFailed") });
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const blob = await exportBackup();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = backupFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const button = "rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-accent-soft disabled:opacity-50";

  return (
    <section className="rounded-lg border border-line bg-white p-5">
      <h2 className="text-lg font-bold">{t("dataTitle")}</h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">{t("dataLead")}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={button} disabled={busy} onClick={() => void download()}>
          {t("exportData")}
        </button>
        <button type="button" className={button} disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("importData")}
        </button>
        <button
          type="button"
          className={`${button} text-danger`}
          disabled={busy}
          onClick={() => {
            if (window.confirm(t("resetConfirm"))) void run(resetToDemo, t("resetDone"));
          }}
        >
          {t("resetDemo")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && window.confirm(t("importConfirm"))) void run(() => importBackup(file), t("importDone"));
          }}
        />
      </div>
      {notice && (
        <p className={`mt-3 text-sm font-semibold ${notice.ok ? "text-accent-strong" : "text-danger"}`} role="status">
          {notice.text}
        </p>
      )}
    </section>
  );
}
