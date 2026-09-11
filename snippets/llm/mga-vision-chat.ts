/**
 * scopes: [backend]
 * flags: [ai-chat]
 * description: Send images + text to MGA (TypeScript) for visual analysis via /chat/completions.
 */

/**
 * MGA Vision Chat (TypeScript)
 *
 * Calls /chat/completions (OpenAI-compatible) with multi-content message
 * blocks for vision tasks: image classification, OCR-light, "describe this
 * screenshot", visual Q&A.
 *
 * Why /chat/completions instead of /chat/agent: /chat/agent is flagged
 * experimental and its multi-content message support is undocumented.
 * /chat/completions is stable and accepts the standard
 *   content: [{type:'text'}, {type:'image_url'}]
 * array. Trade-off: conversation memory + tool use don't apply.
 *
 * Vision-capable models (set MGA_VISION_MODEL to override default):
 *   claude-opus-4.7 (default), claude-sonnet-4.6, gpt-4o, gpt-4o-mini,
 *   gpt-5, gpt-5-mini, gemini-2.5-pro, gemini-2.5-flash.
 *
 * Dependencies: none (Node 18+).
 *
 * Environment variables:
 *   MGA_API_KEY, MGA_BASE_URL          — written by harness
 *   MGA_VISION_MODEL                   — optional; defaults to claude-opus-4.7
 *
 * Example:
 *   import { analyzeImage } from './mga-vision-chat.js';
 *   const answer = await analyzeImage('What is in this image?', { url: 'https://example.com/photo.jpg' });
 *   const answer2 = await analyzeImage('Extract the receipt total', {
 *     base64: imgBuffer.toString('base64'),
 *     mime: 'image/png',
 *   });
 */

const MGA_API_KEY: string | undefined = process.env.MGA_API_KEY;
const MGA_BASE_URL: string =
  process.env.MGA_BASE_URL || 'https://chat.int.bayer.com/api/v2';
const MGA_VISION_MODEL: string = process.env.MGA_VISION_MODEL || 'claude-opus-4.7';

if (!MGA_API_KEY) {
  throw new Error('MGA not configured. Set MGA_API_KEY in env.');
}

export type VisionImage =
  | { url: string }
  | { base64: string; mime: string };

export interface AnalyzeImageOptions {
  model?: string;
  temperature?: number;
}

interface VisionRequestBody {
  model: string;
  temperature: number;
  messages: Array<{
    role: 'user';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;
  }>;
  stream: boolean;
}

interface VisionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Analyze an image with a text prompt.
 */
export async function analyzeImage(
  prompt: string,
  image: VisionImage,
  options: AnalyzeImageOptions = {}
): Promise<string> {
  let imageUrl: string;
  if ('url' in image && image.url) {
    imageUrl = image.url;
  } else if ('base64' in image && image.base64 && image.mime) {
    imageUrl = `data:${image.mime};base64,${image.base64}`;
  } else {
    throw new Error('image must be { url } or { base64, mime }');
  }

  const body: VisionRequestBody = {
    model: options.model || MGA_VISION_MODEL,
    temperature: options.temperature ?? 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    stream: false,
  };

  const res = await fetch(
    `${MGA_BASE_URL.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MGA_API_KEY}`,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MGA vision failed: HTTP ${res.status} — ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as VisionResponse;
  return data.choices?.[0]?.message?.content || '';
}
