# cline-derived/

Code in this directory is **adapted from [Cline](https://github.com/cline/cline)**, an Apache 2.0 open-source AI coding agent.

## Source

- Upstream: https://github.com/cline/cline
- License: Apache License 2.0
- Ported from: shallow clone of `main` (cloned 2026-04-21 for this spike)

## What was ported vs. adapted

| Our file | Adapted from upstream | Notes |
|---|---|---|
| `xml-parser.js` | `src/core/assistant-message/parse-assistant-message.ts` + `index.ts` (toolParamNames) | Ported to plain JS. Trimmed param list to tools we use. Uses `crypto.randomUUID().slice(0,8)` instead of nanoid. |
| `tool-formatting.md` | `src/core/prompts/system-prompt/components/tool_use/formatting.ts` | Verbatim template body as markdown for pasting into MGA assistant config. |

## Why ported rather than rewritten

Cline's XML parser handles edge cases we'd spend days rediscovering: partial tags during streaming, nested content tags inside `write_to_file`, multi-tool-call-in-one-response, malformed model output, etc. Apache 2.0 permits copying with attribution; re-implementing would be wasted effort.

## License

Files in this directory retain Apache 2.0 — each includes a source header identifying the original file. The rest of this repo's license terms apply to our own code in `chat/server/agent/`.
