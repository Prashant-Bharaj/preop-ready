import type { Readiness } from "../api";
import { useI18n } from "../i18n";

const styles: Record<Readiness, string> = {
  GREEN: "border-success/30 bg-success/15 text-success",
  YELLOW: "border-warning/30 bg-warning/15 text-warning",
  RED: "border-danger/30 bg-danger/15 text-danger",
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
