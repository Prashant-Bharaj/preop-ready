/** Progress callback for long OCR jobs; the upload panel subscribes to it.
 * Kept in its own module so the UI does not statically pull in the router. */
export type ExtractProgress = (message: string, ratio?: number) => void;

let sink: ExtractProgress | null = null;

export function setExtractProgress(cb: ExtractProgress | null) {
  sink = cb;
}

export function reportExtractProgress(message: string, ratio?: number) {
  sink?.(message, ratio);
}
