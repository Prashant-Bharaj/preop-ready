/**
 * scopes: [backend]
 * flags: [search-external]
 * description: Brave Search API integration (TypeScript).
 */

/**
 * Brave Search API Integration (TypeScript)
 *
 * Query the Brave Search API for web results.
 *
 * Environment variables:
 *   BRAVE_API_KEY — Brave Search API key
 *
 * Example:
 *   import { braveSearch } from './brave-search.js';
 *   const results = await braveSearch('weather in Berlin');
 */

const BRAVE_API_KEY: string | undefined = process.env.BRAVE_API_KEY;
const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1';

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchOptions {
  count?: number;
}

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{ title: string; url: string; description: string }>;
  };
}

export async function braveSearch(
  query: string,
  { count = 5 }: BraveSearchOptions = {}
): Promise<BraveSearchResult[]> {
  if (!BRAVE_API_KEY) {
    throw new Error('BRAVE_API_KEY is not set');
  }

  const params = new URLSearchParams({ q: query, count: String(count) });
  const res = await fetch(`${BRAVE_BASE_URL}/web/search?${params}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave API error (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as BraveWebSearchResponse;
  return (data.web?.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
  }));
}
