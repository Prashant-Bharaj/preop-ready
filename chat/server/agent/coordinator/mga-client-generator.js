/**
 * mga-client-generator.js — emits the canonical MGA chat client as a
 * pre-staged backend lib file.
 *
 * Emitted when the contract has `flags: [..., 'ai-chat']` OR a non-empty
 * `mgaAssistants` array. Otherwise returns null.
 *
 * The MGA transport is fully known ahead of time (env var names, Bearer
 * auth, base URL, /chat/agent body shape) — an LLM should never author it.
 * Hand-rolled clients were the #1 AI-app failure mode: hallucinated
 * hostnames, missing Authorization headers, non-MGA model defaults.
 *
 * The emitted client enforces:
 *   - reads MGA_API_KEY / MGA_BASE_URL / MGA_ASSISTANT_ID from env only
 *   - `Authorization: Bearer` on every call
 *   - env validated lazily per-call (a missing key 500s the AI endpoint;
 *     it must NOT boot-crash the whole app the way a module-level throw does)
 *
 * Node backends get chatWithAssistant() + a streamChat SSE RequestHandler
 * (mirrors snippets/llm/mga-assistant-client.ts + mga-streaming-chat.ts).
 * Python backends get chat_with_assistant(); SSE streaming stays a snippet
 * fetch (llm/mga-streaming-chat.py) since FastAPI streaming needs app-level
 * route wiring anyway.
 */

export function shouldEmitMgaClient(contract) {
  const flags = contract?.flags || [];
  if (Array.isArray(flags) && flags.includes('ai-chat')) return true;
  if (Array.isArray(contract?.mgaAssistants) && contract.mgaAssistants.length > 0) return true;
  return false;
}

function backendIsPython(contract) {
  const backendTask = (contract?.tasks || []).find(t => t?.scope === 'backend');
  return backendTask?.dockerfile === 'Dockerfile.python';
}

export function generateMgaClient(contract) {
  if (!shouldEmitMgaClient(contract)) return null;
  return backendIsPython(contract)
    ? { relPath: 'backend/src/mga_client.py', source: pythonSource() }
    : { relPath: 'backend/src/lib/mga-client.ts', source: tsSource() };
}

function tsSource() {
  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT OR REWRITE — pre-staged because the contract`);
  lines.push(`// has flags=['ai-chat'] or mga_assistants. Import from this file; never`);
  lines.push(`// hand-roll MGA fetch calls, hostnames, or model names.`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Canonical MGA assistant client.`);
  lines.push(` *`);
  lines.push(` * Env vars (written to the workspace .env by the harness at confirm time;`);
  lines.push(` * wired into this container by docker-compose):`);
  lines.push(` *   MGA_API_KEY      — bearer token`);
  lines.push(` *   MGA_BASE_URL     — defaults to https://chat.int.bayer.com/api/v2`);
  lines.push(` *   MGA_ASSISTANT_ID — the per-app assistant UUID`);
  lines.push(` *`);
  lines.push(` * Usage:`);
  lines.push(` *   import { chatWithAssistant, streamChat } from './lib/mga-client.js';`);
  lines.push(` *   const r = await chatWithAssistant('Hello');                 // one-shot`);
  lines.push(` *   app.post('/api/chat/stream', streamChat);                   // SSE proxy`);
  lines.push(` *`);
  lines.push(` * Env is validated per-call, not at import — a missing key must fail the`);
  lines.push(` * AI endpoint with a clear 500, not boot-crash the whole app.`);
  lines.push(` */`);
  lines.push('');
  lines.push(`import type { Request, Response, RequestHandler } from 'express';`);
  lines.push('');
  lines.push(`interface MgaEnv { apiKey: string; baseUrl: string; assistantId: string; }`);
  lines.push('');
  lines.push(`function mgaEnv(): MgaEnv {`);
  lines.push(`  const apiKey = process.env.MGA_API_KEY;`);
  lines.push(`  const baseUrl = (process.env.MGA_BASE_URL || 'https://chat.int.bayer.com/api/v2').replace(/\\/$/, '');`);
  lines.push(`  const assistantId = process.env.MGA_ASSISTANT_ID;`);
  lines.push(`  if (!apiKey || !assistantId) {`);
  lines.push(`    throw new Error('MGA not configured: set MGA_API_KEY and MGA_ASSISTANT_ID in env (the harness writes them to the workspace .env at confirm time)');`);
  lines.push(`  }`);
  lines.push(`  return { apiKey, baseUrl, assistantId };`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export interface ChatWithAssistantOptions {`);
  lines.push(`  /** Continue a prior server-held conversation. */`);
  lines.push(`  conversationId?: string | null;`);
  lines.push(`  /** Per-call tool override; usually leave undefined. */`);
  lines.push(`  toolKeys?: string[] | null;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export interface ChatWithAssistantResult {`);
  lines.push(`  text: string;`);
  lines.push(`  conversationId: string | null;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`interface ChatAgentBody {`);
  lines.push(`  assistant_id: string;`);
  lines.push(`  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;`);
  lines.push(`  stream: boolean;`);
  lines.push(`  hidden: boolean;`);
  lines.push(`  conversation_id?: string;`);
  lines.push(`  tool_keys?: string[];`);
  lines.push(`}`);
  lines.push('');
  lines.push(`interface ChatAgentResponse {`);
  lines.push(`  choices?: Array<{ message?: { content?: string } }>;`);
  lines.push(`  conversation_id?: string | null;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export async function chatWithAssistant(`);
  lines.push(`  message: string,`);
  lines.push(`  { conversationId = null, toolKeys = null }: ChatWithAssistantOptions = {}`);
  lines.push(`): Promise<ChatWithAssistantResult> {`);
  lines.push(`  const env = mgaEnv();`);
  lines.push(`  const body: ChatAgentBody = {`);
  lines.push(`    assistant_id: env.assistantId,`);
  lines.push(`    messages: [{ role: 'user', content: message }],`);
  lines.push(`    stream: false,`);
  lines.push(`    hidden: false,`);
  lines.push(`  };`);
  lines.push(`  if (conversationId) body.conversation_id = conversationId;`);
  lines.push(`  if (Array.isArray(toolKeys)) body.tool_keys = toolKeys;`);
  lines.push('');
  lines.push(`  const res = await fetch(\`\${env.baseUrl}/chat/agent\`, {`);
  lines.push(`    method: 'POST',`);
  lines.push(`    headers: {`);
  lines.push(`      'Content-Type': 'application/json',`);
  lines.push(`      Authorization: \`Bearer \${env.apiKey}\`,`);
  lines.push(`    },`);
  lines.push(`    body: JSON.stringify(body),`);
  lines.push(`  });`);
  lines.push('');
  lines.push(`  if (!res.ok) {`);
  lines.push(`    const txt = await res.text().catch(() => '');`);
  lines.push(`    throw new Error(\`MGA chat failed: HTTP \${res.status} — \${txt.slice(0, 300)}\`);`);
  lines.push(`  }`);
  lines.push(`  const data = (await res.json()) as ChatAgentResponse;`);
  lines.push(`  return {`);
  lines.push(`    text: data.choices?.[0]?.message?.content || '',`);
  lines.push(`    conversationId: data.conversation_id || null,`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push('');
  lines.push(`interface StreamChatBody {`);
  lines.push(`  message?: string;`);
  lines.push(`  conversationId?: string;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`interface StreamEvent {`);
  lines.push(`  delta?: string;`);
  lines.push(`  conversationId?: string;`);
  lines.push(`  done?: boolean;`);
  lines.push(`  error?: string;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`interface MgaSseChunk {`);
  lines.push(`  choices?: Array<{ delta?: { content?: string } }>;`);
  lines.push(`  conversation_id?: string;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`type FlushableResponse = Response & { flush?: () => void };`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * SSE proxy: streams the assistant's response to the browser. The API key`);
  lines.push(` * never reaches the client — this handler is the only holder.`);
  lines.push(` * Request body: { message: string, conversationId?: string }`);
  lines.push(` * Stream events: {delta} | {conversationId} | {done} | {error}`);
  lines.push(` */`);
  lines.push(`export const streamChat: RequestHandler = async (req: Request, res: Response) => {`);
  lines.push(`  const { message, conversationId } = (req.body || {}) as StreamChatBody;`);
  lines.push(`  if (typeof message !== 'string' || message.length === 0) {`);
  lines.push(`    res.status(400).json({ error: 'message required' });`);
  lines.push(`    return;`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  let env: MgaEnv;`);
  lines.push(`  try {`);
  lines.push(`    env = mgaEnv();`);
  lines.push(`  } catch (err) {`);
  lines.push(`    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });`);
  lines.push(`    return;`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  res.setHeader('Content-Type', 'text/event-stream');`);
  lines.push(`  res.setHeader('Cache-Control', 'no-cache');`);
  lines.push(`  res.setHeader('Connection', 'keep-alive');`);
  lines.push(`  if (typeof res.flushHeaders === 'function') res.flushHeaders();`);
  lines.push('');
  lines.push(`  const send = (obj: StreamEvent): void => {`);
  lines.push(`    res.write(\`data: \${JSON.stringify(obj)}\\n\\n\`);`);
  lines.push(`    const flushable = res as FlushableResponse;`);
  lines.push(`    if (typeof flushable.flush === 'function') flushable.flush();`);
  lines.push(`  };`);
  lines.push('');
  lines.push(`  const body: ChatAgentBody = {`);
  lines.push(`    assistant_id: env.assistantId,`);
  lines.push(`    messages: [{ role: 'user', content: message }],`);
  lines.push(`    stream: true,`);
  lines.push(`    hidden: false,`);
  lines.push(`  };`);
  lines.push(`  if (conversationId) body.conversation_id = conversationId;`);
  lines.push('');
  lines.push(`  try {`);
  lines.push(`    const upstream = await fetch(\`\${env.baseUrl}/chat/agent\`, {`);
  lines.push(`      method: 'POST',`);
  lines.push(`      headers: {`);
  lines.push(`        'Content-Type': 'application/json',`);
  lines.push(`        Authorization: \`Bearer \${env.apiKey}\`,`);
  lines.push(`        Accept: 'text/event-stream',`);
  lines.push(`      },`);
  lines.push(`      body: JSON.stringify(body),`);
  lines.push(`    });`);
  lines.push('');
  lines.push(`    if (!upstream.ok) {`);
  lines.push(`      const txt = await upstream.text().catch(() => '');`);
  lines.push(`      send({ error: \`Upstream HTTP \${upstream.status}: \${txt.slice(0, 300)}\` });`);
  lines.push(`      res.end();`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    if (!upstream.body) {`);
  lines.push(`      send({ error: 'Upstream returned no body stream' });`);
  lines.push(`      res.end();`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push('');
  lines.push(`    const reader = upstream.body.getReader();`);
  lines.push(`    const decoder = new TextDecoder();`);
  lines.push(`    let buf = '';`);
  lines.push(`    let convoIdSent = false;`);
  lines.push('');
  lines.push(`    while (true) {`);
  lines.push(`      const { value, done } = await reader.read();`);
  lines.push(`      if (done) break;`);
  lines.push(`      buf += decoder.decode(value, { stream: true });`);
  lines.push('');
  lines.push(`      let nl: number;`);
  lines.push(`      while ((nl = buf.indexOf('\\n\\n')) !== -1) {`);
  lines.push(`        const event = buf.slice(0, nl);`);
  lines.push(`        buf = buf.slice(nl + 2);`);
  lines.push(`        const dataLine = event.split('\\n').find((l) => l.startsWith('data:'));`);
  lines.push(`        if (!dataLine) continue;`);
  lines.push(`        const payload = dataLine.slice(5).trim();`);
  lines.push(`        if (!payload || payload === '[DONE]') continue;`);
  lines.push(`        try {`);
  lines.push(`          const parsed = JSON.parse(payload) as MgaSseChunk;`);
  lines.push(`          const delta = parsed.choices?.[0]?.delta?.content;`);
  lines.push(`          if (delta) send({ delta });`);
  lines.push(`          if (!convoIdSent && parsed.conversation_id) {`);
  lines.push(`            send({ conversationId: parsed.conversation_id });`);
  lines.push(`            convoIdSent = true;`);
  lines.push(`          }`);
  lines.push(`        } catch {`);
  lines.push(`          // Non-JSON keepalive or comment — ignore.`);
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`    send({ done: true });`);
  lines.push(`    res.end();`);
  lines.push(`  } catch (err) {`);
  lines.push(`    send({ error: err instanceof Error ? err.message : String(err) });`);
  lines.push(`    res.end();`);
  lines.push(`  }`);
  lines.push(`};`);
  lines.push('');
  return lines.join('\n');
}

function pythonSource() {
  const lines = [];
  lines.push(`# AUTO-GENERATED — DO NOT EDIT OR REWRITE — pre-staged because the contract`);
  lines.push(`# has flags=['ai-chat'] or mga_assistants. Import from this file; never`);
  lines.push(`# hand-roll MGA HTTP calls, hostnames, or model names.`);
  lines.push(`"""Canonical MGA assistant client.`);
  lines.push('');
  lines.push(`Env vars (written to the workspace .env by the harness at confirm time;`);
  lines.push(`wired into this container by docker-compose):`);
  lines.push(`  MGA_API_KEY      — bearer token`);
  lines.push(`  MGA_BASE_URL     — defaults to https://chat.int.bayer.com/api/v2`);
  lines.push(`  MGA_ASSISTANT_ID — the per-app assistant UUID`);
  lines.push('');
  lines.push(`Usage:`);
  lines.push(`  from src.mga_client import chat_with_assistant`);
  lines.push(`  result = await chat_with_assistant("Hello")`);
  lines.push('');
  lines.push(`For SSE streaming to the browser, fetch the llm/mga-streaming-chat.py`);
  lines.push(`snippet via get_snippet and wire it as a FastAPI route.`);
  lines.push('');
  lines.push(`Env is validated per-call, not at import — a missing key must fail the`);
  lines.push(`AI endpoint with a clear 500, not boot-crash the whole app.`);
  lines.push(`"""`);
  lines.push('');
  lines.push(`import os`);
  lines.push(`from typing import Any, Optional`);
  lines.push('');
  lines.push(`import httpx`);
  lines.push('');
  lines.push('');
  lines.push(`def _mga_env() -> dict:`);
  lines.push(`    api_key = os.getenv("MGA_API_KEY")`);
  lines.push(`    base_url = (os.getenv("MGA_BASE_URL") or "https://chat.int.bayer.com/api/v2").rstrip("/")`);
  lines.push(`    assistant_id = os.getenv("MGA_ASSISTANT_ID")`);
  lines.push(`    if not api_key or not assistant_id:`);
  lines.push(`        raise RuntimeError(`);
  lines.push(`            "MGA not configured: set MGA_API_KEY and MGA_ASSISTANT_ID in env "`);
  lines.push(`            "(the harness writes them to the workspace .env at confirm time)"`);
  lines.push(`        )`);
  lines.push(`    return {"api_key": api_key, "base_url": base_url, "assistant_id": assistant_id}`);
  lines.push('');
  lines.push('');
  lines.push(`async def chat_with_assistant(`);
  lines.push(`    message: str,`);
  lines.push(`    conversation_id: Optional[str] = None,`);
  lines.push(`    tool_keys: Optional[list] = None,`);
  lines.push(`) -> dict:`);
  lines.push(`    """One-shot assistant chat. Returns {"text": str, "conversation_id": str|None}."""`);
  lines.push(`    env = _mga_env()`);
  lines.push(`    body: dict[str, Any] = {`);
  lines.push(`        "assistant_id": env["assistant_id"],`);
  lines.push(`        "messages": [{"role": "user", "content": message}],`);
  lines.push(`        "stream": False,`);
  lines.push(`        "hidden": False,`);
  lines.push(`    }`);
  lines.push(`    if conversation_id:`);
  lines.push(`        body["conversation_id"] = conversation_id`);
  lines.push(`    if tool_keys is not None:`);
  lines.push(`        body["tool_keys"] = tool_keys`);
  lines.push('');
  lines.push(`    async with httpx.AsyncClient(timeout=60.0) as client:`);
  lines.push(`        res = await client.post(`);
  lines.push(`            f"{env['base_url']}/chat/agent",`);
  lines.push(`            json=body,`);
  lines.push(`            headers={"Authorization": f"Bearer {env['api_key']}"},`);
  lines.push(`        )`);
  lines.push(`    if res.status_code >= 400:`);
  lines.push(`        raise RuntimeError(f"MGA chat failed: HTTP {res.status_code} — {res.text[:300]}")`);
  lines.push(`    data = res.json()`);
  lines.push(`    choices = data.get("choices") or [{}]`);
  lines.push(`    return {`);
  lines.push(`        "text": (choices[0].get("message") or {}).get("content", ""),`);
  lines.push(`        "conversation_id": data.get("conversation_id"),`);
  lines.push(`    }`);
  lines.push('');
  return lines.join('\n');
}
