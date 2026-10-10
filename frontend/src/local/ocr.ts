// Read text from PDFs and images entirely in the browser.
// - PDFs: use the embedded text layer (pdf.js); scanned pages fall back to OCR.
// - Images: Tesseract.js OCR (German + English).
// All engine and language files are self-hosted under <base>/ocr/ (see the
// localAssets plugin in vite.config.ts). Nothing is fetched from a CDN, and the
// document never leaves the device.

import type { Worker as TesseractWorker } from "tesseract.js";

const MAX_PDF_PAGES = 20;
const MAX_OCR_PAGES = 5;

export type Progress = (message: string, ratio?: number) => void;

function assetBase(): string {
  return new URL(`${import.meta.env.BASE_URL}ocr/`, window.location.href).href;
}

let workerPromise: Promise<TesseractWorker> | null = null;
let progressSink: Progress | null = null;

async function ocrWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, OEM } = await import("tesseract.js");
      const base = assetBase();
      return createWorker(["deu", "eng"], OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: base,
        workerBlobURL: false,
        logger: (m: { status: string; progress: number }) => progressSink?.(m.status, m.progress),
      });
    })();
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

export async function ocrImage(image: Blob | HTMLCanvasElement, onProgress?: Progress): Promise<string> {
  progressSink = onProgress || null;
  try {
    const worker = await ocrWorker();
    const { data } = await worker.recognize(image);
    return data.text || "";
  } finally {
    progressSink = null;
  }
}

export interface PdfText {
  text: string;
  usedOcr: boolean;
}

export async function pdfText(file: Blob, onProgress?: Progress): Promise<PdfText> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false })
    .promise;
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        } else {
          line += " ";
        }
      }
      if (line.trim()) lines.push(line);
      parts.push(lines.join("\n"));
    }
    const text = parts.join("\n");
    // A text layer with real words means the PDF was born digital.
    if (text.replace(/\s/g, "").length >= 40) return { text, usedOcr: false };

    // Scanned PDF: render pages and OCR them.
    const ocrPages = Math.min(doc.numPages, MAX_OCR_PAGES);
    const ocrParts: string[] = [];
    for (let i = 1; i <= ocrPages; i++) {
      onProgress?.(`page ${i}/${ocrPages}`);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) break;
      await page.render({ canvasContext: context, viewport }).promise;
      ocrParts.push(await ocrImage(canvas, onProgress));
      canvas.width = 0;
      canvas.height = 0;
    }
    return { text: ocrParts.join("\n"), usedOcr: true };
  } finally {
    await doc.destroy();
  }
}
