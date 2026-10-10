import { NavLink, Outlet } from "react-router-dom";
import { useI18n } from "../i18n";

const link = "rounded-md px-3 py-2 text-sm font-semibold text-ink/80 hover:bg-sky-50";
const active = "bg-sky-100 text-sky-950";

export function Layout() {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="min-h-screen">
      <div className="bg-amber-100 px-4 py-2 text-center text-sm font-semibold text-amber-950">
        {t("banner")}
      </div>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div>
            <p className="text-2xl font-bold tracking-tight text-ink">{t("title")}</p>
            <p className="text-sm text-slate-600">{t("subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`rounded-md px-3 py-1 text-sm font-bold ${lang === "de" ? "bg-ink text-white" : "bg-slate-100"}`}
              onClick={() => setLang("de")}
            >
              DE
            </button>
            <button
              type="button"
              className={`rounded-md px-3 py-1 text-sm font-bold ${lang === "en" ? "bg-ink text-white" : "bg-slate-100"}`}
              onClick={() => setLang("en")}
            >
              EN
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl flex-wrap gap-1 px-4 pb-3">
          <NavLink to="/" end className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
            {t("navWorklist")}
          </NavLink>
          <NavLink to="/tasks" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
            {t("navTasks")}
          </NavLink>
          <NavLink to="/upload" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
            {t("navUpload")}
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
            {t("navSettings")}
          </NavLink>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
