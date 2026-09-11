/**
 * scopes: [frontend]
 * flags: [search-ui, search-external]
 * description: Search page (TypeScript + Tailwind + shadcn) with input, fetch, results list, loading/empty/error states.
 */

/**
 * React Search Page Template (TypeScript + Tailwind)
 *
 * Generic search page with text input, debounced API fetch, and results list.
 * Adapt the API endpoint, result fields, and card layout to your project.
 *
 * Place at frontend/src/pages/SearchPage.tsx.
 */

import * as React from 'react';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card.js';
import { Badge } from '../components/Badge.js';
import { Alert, AlertDescription } from '../components/Alert.js';

interface SearchResult {
  id?: string | number;
  title: string;
  description?: string;
  content?: string;
  score?: number;
}

interface SearchResponse {
  results?: SearchResult[];
}

export function SearchPage(): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSearch(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = (await res.json()) as SearchResponse;
      setResults(data.results || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Search</h1>

      <form
        onSubmit={handleSearch}
        className="flex w-full max-w-2xl items-center gap-2"
      >
        <Input
          type="text"
          placeholder="Search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" disabled={loading}>
          {loading ? 'Searching...' : 'Search'}
        </Button>
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4">
        {results.map((item, i) => (
          <Card key={item.id ?? i}>
            <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
              <CardTitle className="text-lg">{item.title}</CardTitle>
              {item.score != null && (
                <Badge variant="secondary">
                  {(item.score * 100).toFixed(0)}% match
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">
                {item.description || item.content}
              </p>
            </CardContent>
          </Card>
        ))}
        {!loading && !error && results.length === 0 && query && (
          <p className="text-sm text-slate-500">No results found.</p>
        )}
      </div>
    </div>
  );
}

export default SearchPage;
