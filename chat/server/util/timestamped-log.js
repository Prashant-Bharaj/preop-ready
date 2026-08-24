/** Timestamped logging — prepends HH:MM:SS to all log lines. */
const _log = console.log.bind(console);
const _err = console.error.bind(console);

export function tlog(...args) {
  const ts = new Date().toTimeString().slice(0, 8);
  if (typeof args[0] === 'string') args[0] = `[${ts}] ${args[0]}`;
  _log(...args);
}

export function terr(...args) {
  const ts = new Date().toTimeString().slice(0, 8);
  if (typeof args[0] === 'string') args[0] = `[${ts}] ${args[0]}`;
  _err(...args);
}
