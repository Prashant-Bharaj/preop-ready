import { NavLink, Outlet } from "react-router-dom";
import { useI18n } from "../i18n";
import { useTheme, type Theme } from "../theme";

const link = "relative rounded-lg px-3 py-2 text-sm font-semibold text-muted hover:bg-accent-soft hover:text-accent-strong";
const active = "bg-accent-soft text-accent-strong after:absolute after:inset-x-3 after:-bottom-[13px] after:h-0.5 after:bg-accent";

const themes: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
];

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  return (
    <div className="min-h-[100dvh]">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-accent text-base font-black text-white shadow-sm shadow-accent/30">PR</div>
            <div>
              <p className="text-xl font-extrabold tracking-tight text-ink">{t("title")}</p>
              <p className="text-xs font-medium text-muted">{t("subtitle")}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="flex rounded-lg border border-line bg-surface-raised p-1" aria-label="Color theme">
              {themes.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setTheme(item.value)}
                  className={`rounded-md px-2 py-1 text-xs font-bold ${theme === item.value ? "bg-surface text-accent-strong shadow-sm" : "text-muted hover:text-ink"}`}
                  aria-pressed={theme === item.value}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex rounded-lg border border-line bg-surface-raised p-1" aria-label="Language">
              {(["de", "en"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded-md px-2 py-1 text-xs font-bold ${lang === value ? "bg-surface text-accent-strong shadow-sm" : "text-muted hover:text-ink"}`}
                  onClick={() => setLang(value)}
                  aria-pressed={lang === value}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-3 lg:px-6" aria-label="Main navigation">
          <NavLink to="/" end className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
            {t("navWorklist")}
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
            {t("navSettings")}
          </NavLink>
        </nav>
      </header>
      <div className="border-b border-line bg-accent-soft">
        <p className="mx-auto max-w-7xl px-4 py-2 text-xs font-semibold text-accent-strong lg:px-6" role="note">
          {t("localNotice")}
        </p>
      </div>
      <main className="mx-auto max-w-7xl px-4 py-6 lg:px-6 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
