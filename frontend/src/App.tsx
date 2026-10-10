import { HashRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { I18nProvider } from "./i18n";
import { PatientDetail } from "./pages/PatientDetail";
import { Settings } from "./pages/Settings";
import { Worklist } from "./pages/Worklist";

export function App() {
  return (
    <I18nProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Worklist />} />
            <Route path="patients/:id" element={<PatientDetail />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </HashRouter>
    </I18nProvider>
  );
}
