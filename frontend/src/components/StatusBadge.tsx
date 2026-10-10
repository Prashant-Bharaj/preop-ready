import type { Readiness } from "../api";
import { useI18n } from "../i18n";

const styles: Record<Readiness, string> = {
  GREEN: "bg-emerald-700 text-white",
  YELLOW: "bg-amber-400 text-slate-950",
  RED: "bg-red-700 text-white",
};

export function StatusBadge({ status, large = false }: { status: Readiness; large?: boolean }) {
  const { t } = useI18n();
  const label = status === "GREEN" ? t("green") : status === "YELLOW" ? t("yellow") : t("red");
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold tracking-wide ${styles[status]} ${
        large ? "min-w-24 px-4 py-2 text-lg" : "min-w-16 px-3 py-1 text-sm"
      }`}
    >
      {label}
    </span>
  );
}
