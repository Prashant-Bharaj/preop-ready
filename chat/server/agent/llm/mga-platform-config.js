/**
 * MGA platform configuration — single source of truth for the curated model
 * list and tool whitelist exposed to the router via `task.mgaAssistant`.
 *
 * Two consumers:
 *   1. router.js validateMgaAssistantSpec — rejects models/tool_keys outside
 *      the curated set so router can't emit garbage.
 *   2. .platform-rules/mga-platform.md — generated from these constants so
 *      the catalog doc stays in lock-step with what the validator accepts.
 *
 * Why curate vs. accepting whatever live `/models` and `/tools` return:
 *   - /tools includes Bayer-specific KB tools (Hubble, FDA, COLID, PubMed,
 *     ~30 entries). User apps shouldn't tap into them; permissions usually
 *     fail at runtime anyway. Generic-only keeps the router's choices safe.
 *   - /models has 72 entries, many deprecated/legacy (gpt-3.5-turbo, gpt-4,
 *     o1-mini, mistral-large-2402-mga). Router shouldn't pick those.
 *
 * If a tool/model needs adding, edit this file. Both the validator AND the
 * catalog doc pick it up.
 */

/**
 * Models the router may pick. Use-case strings are surfaced in router.md so
 * the router has a one-line decision aid per model. Keep this list short —
 * 10-12 models is the practical ceiling for the router's working memory.
 */
export const MODELS = {
  'claude-opus-4.7':       { tier: 'flagship',  vision: true,  pdf: false, useCase: 'default chatbots; flagship text + vision' },
  'claude-sonnet-5':       { tier: 'fast',      vision: true,  pdf: false, useCase: 'latest Sonnet: near-Opus quality at Sonnet pricing; 1M ctx, 128K out' },
  'claude-sonnet-4.6':     { tier: 'fast',      vision: true,  pdf: false, useCase: 'fast text + vision; cheaper than opus' },
  'gpt-4o':                { tier: 'standard',  vision: true,  pdf: false, useCase: 'general OpenAI text + vision' },
  'gpt-4o-mini':           { tier: 'fast',      vision: true,  pdf: false, useCase: 'low-latency OpenAI; cheap' },
  'gpt-5':                 { tier: 'flagship',  vision: true,  pdf: false, useCase: 'newer GPT family flagship' },
  'gpt-5-mini':            { tier: 'fast',      vision: true,  pdf: false, useCase: 'newer GPT family fast' },
  'gemini-2.5-pro':        { tier: 'flagship',  vision: true,  pdf: true,  useCase: 'PDF input + large context (only Gemini/Claude take PDF)' },
  'gemini-2.5-flash':      { tier: 'fast',      vision: true,  pdf: true,  useCase: 'PDF input + fast' },
  'o4-mini':               { tier: 'reasoning', vision: true,  pdf: false, useCase: 'reasoning-heavy (math, logic, multi-step)' },
  'text-embedding-3-large':{ tier: 'embedding', useCase: 'embeddings — highest quality' },
  'text-embedding-3-small':{ tier: 'embedding', useCase: 'embeddings — fast and cheap' },
};

export const DEFAULT_MODEL = 'claude-opus-4.7';
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-large';

/**
 * Tools the router can put in `task.mgaAssistant.tool_keys`. These are
 * attached to the assistant via POST /assistants/{id}/tools at /confirm time.
 *
 * Picked from the live MGA /tools catalog, filtered to general-purpose
 * (no Bayer-specific KBs).
 */
export const ATTACHABLE_TOOLS = [
  'websearch',           // browse the live web
  'web_scraper',         // fetch a specific URL's content
  'code_interpreter',    // run code, analyze CSV, generate graphs
  'img_generator',       // generate / edit images from text prompts
  'video_generator',     // generate videos via Veo 3 from text prompts
  'pdf_generator',       // create PDF documents
  'word_generator',      // create Word (DOCX) documents
  'powerpointer',        // create PowerPoint presentations
  'document_generator',  // generic doc generator (PDF/DOCX/PPTX)
  'podcast_generator',   // generate podcasts from documents
];

/**
 * Tools that `/chat/agent` enables by default when no `tool_keys` are passed.
 * The router doesn't need to attach these — they come for free. Listed here
 * so the validator accepts them (router may emit them explicitly to make
 * the assistant's behaviour visible) but the create-assistant attach flow
 * filters them out.
 */
export const CHAT_AGENT_DEFAULT_TOOLS = [
  'document_question_answering',
  'document_summarizer',
  'uploaded_docs',
];

/**
 * One-line description per tool. Read by the prompt-writer agent (see
 * chat/server/agent/planner/prompt-writer.js) so it can write tool-aware system
 * prompts: "Use websearch when..." vs "Use uploaded_docs when...".
 *
 * Keep descriptions short (one sentence) and FUNCTIONAL — describe what
 * the assistant should USE the tool for, not how the tool works internally.
 */
export const TOOL_DESCRIPTIONS = {
  websearch:                   'Search the live web for current information (news, prices, recent events).',
  web_scraper:                 'Fetch and parse content from a specific URL the user references.',
  code_interpreter:            'Execute Python code, analyze CSV files, generate graphs.',
  img_generator:               'Generate or edit images from text prompts.',
  video_generator:             'Generate short videos from text prompts (Veo 3).',
  pdf_generator:               'Create PDF documents.',
  word_generator:              'Create Word (DOCX) documents.',
  powerpointer:                'Create PowerPoint (PPTX) presentations.',
  document_generator:          'Generic doc generator (PDF / DOCX / PPTX).',
  podcast_generator:           'Generate podcast audio from documents or notes.',
  document_question_answering: 'Answer questions about documents the user has uploaded.',
  document_summarizer:         'Summarize uploaded documents.',
  uploaded_docs:                'Surface uploaded documents in the chat context for the assistant to reference.',
};

/**
 * Full set the validator accepts in `mgaAssistant.tool_keys`.
 * = ATTACHABLE_TOOLS ∪ CHAT_AGENT_DEFAULT_TOOLS
 */
export const ALLOWED_TOOL_KEYS = new Set([
  ...ATTACHABLE_TOOLS,
  ...CHAT_AGENT_DEFAULT_TOOLS,
]);

/** Names the validator accepts in `mgaAssistant.model`. */
export const ALLOWED_MODEL_IDS = new Set(Object.keys(MODELS));

/**
 * Validation limits for the router-emitted spec.
 * Tight bounds keep prompt drift visible — if the router spits out a 4KB
 * `instructions` block, that's a router bug we want to catch.
 */
export const SPEC_LIMITS = {
  nameMin: 3,
  nameMax: 120,
  descriptionMax: 500,
  instructionsMin: 10,
  instructionsMax: 4000,
  starterMessagesMax: 4,
  starterMessageCharsMax: 200,
  toolKeysMax: 8,
};
