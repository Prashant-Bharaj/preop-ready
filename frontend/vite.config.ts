import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

// OCR runs fully in the browser. Platform rule: no public CDNs — so the
// Tesseract worker, WASM core and language models are self-hosted under
// <base>/ocr/. Only the LSTM-only builds are shipped (what the app requests).
function ocrAssets(): Record<string, string> {
  const tess = pkgDir("tesseract.js");
  const core = pkgDir("tesseract.js-core");
  const files: Record<string, string> = {
    "worker.min.js": join(tess, "dist/worker.min.js"),
    "deu.traineddata.gz": join(pkgDir("@tesseract.js-data/deu"), "4.0.0_best_int/deu.traineddata.gz"),
    "eng.traineddata.gz": join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int/eng.traineddata.gz"),
  };
  for (const variant of ["lstm", "simd-lstm", "relaxedsimd-lstm"]) {
    const name = `tesseract-core-${variant}.wasm.js`;
    files[name] = join(core, name);
  }
  return files;
}

function localOcrAssets(): Plugin {
  const files = ocrAssets();
  return {
    name: "local-ocr-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || "").split("?")[0];
        const prefix = `${server.config.base}ocr/`;
        if (!path.startsWith(prefix)) return next();
        const source = files[path.slice(prefix.length)];
        if (!source) return next();
        res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const [name, source] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName: `ocr/${name}`, source: readFileSync(source) });
      }
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app from /<repo>/; set BASE_PATH there. Locally "/".
  base: process.env.BASE_PATH || "/",
  plugins: [react(), localOcrAssets()],
  server: {
    port: 5173,
  },
});
