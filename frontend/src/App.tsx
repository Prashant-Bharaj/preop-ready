import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { I18nProvider } from "./i18n";
import { PatientDetail } from "./pages/PatientDetail";
import { Settings } from "./pages/Settings";
import { Tasks } from "./pages/Tasks";
import { Upload } from "./pages/Upload";
import { Worklist } from "./pages/Worklist";

export function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Worklist />} />
            <Route path="patients/:id" element={<PatientDetail />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="upload" element={<Upload />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  );
}
