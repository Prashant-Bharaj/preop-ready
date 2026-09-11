let sensitiveStrings = [];

export function setSensitiveStrings(strings) {
  sensitiveStrings = strings.filter(Boolean);
}

/**
 * Strip ANSI escape codes (colors, cursor movement, screen clearing, etc.)
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

export function redact(text) {
  if (!text) return text;
  let result = stripAnsi(text);
  for (const secret of sensitiveStrings) {
    if (secret.length < 4) continue;
    result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}
