// Calendar-day helpers. Dates are ISO "YYYY-MM-DD" strings, compared as UTC days
// so daylight-saving shifts never change a day count.

export type ISODate = string;

const CLINIC_TZ = "Europe/Berlin";

export function clinicToday(): ISODate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function nowStamp(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function toUtc(day: ISODate): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(day: ISODate, days: number): ISODate {
  return new Date(toUtc(day) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (to - from). */
export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** dd.mm.yyyy, matching the backend's strftime("%d.%m.%Y"). */
export function fmt(day: ISODate): string {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
}
