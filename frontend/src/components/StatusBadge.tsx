import type { Readiness } from "../api";
import { useI18n } from "../i18n";

const styles: Record<Readiness, string> = {
  GREEN: "border-success/40 bg-success/20 text-success",
  YELLOW: "border-warning/40 bg-warning/20 text-warning",
  RED: "border-danger/40 bg-danger/20 text-danger",
};

export function StatusBadge({ status, large = false }: { status: Readiness; large?: boolean }) {
  const { t } = useI18n();
  const label = status === "GREEN" ? t("green") : status === "YELLOW" ? t("yellow") : t("red");
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border font-extrabold tracking-wide ${styles[status]} ${
        large ? "min-w-24 px-4 py-2 text-lg" : "min-w-16 px-3 py-1 text-sm"
      }`}
    >
      {label}
    </span>
  );
}
