export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearxngSearchOptions {
  signal?: AbortSignal;
  maxResults?: number;
}

/** Portable SearXNG JSON client shared by runtime nodes and host applications. */
export async function searchSearxng(
  baseUrl: string,
  apiKey: string,
  query: string,
  fetchImpl: typeof fetch,
  options: SearxngSearchOptions = {},
): Promise<WebSearchResult[]> {
  const normalizedQuery = query.trim().slice(0, 500);
  if (!normalizedQuery) throw new Error("web search query must not be empty");

  const endpoint = new URL(baseUrl.trim());
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("SearXNG URL must use HTTP or HTTPS");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/search`;
  endpoint.search = "";
  endpoint.searchParams.set("q", normalizedQuery);
  endpoint.searchParams.set("format", "json");
  endpoint.hash = "";

  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      "X-API-Key": apiKey.trim(),
      Accept: "application/json",
    },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`SearXNG search failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const rows = payload && typeof payload === "object"
    ? (payload as { results?: unknown }).results
    : undefined;
  if (!Array.isArray(rows)) return [];

  const maxResults = Math.max(1, Math.min(20, options.maxResults ?? 6));
  return rows
    .map(readResult)
    .filter((result): result is WebSearchResult => result !== undefined)
    .slice(0, maxResults);
}

function readResult(value: unknown): WebSearchResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { title?: unknown; url?: unknown; content?: unknown };
  if (typeof row.url !== "string" || !isHttpUrl(row.url)) return undefined;
  return {
    title: typeof row.title === "string" && row.title.trim()
      ? row.title.trim().slice(0, 300)
      : row.url,
    url: row.url,
    content: typeof row.content === "string" ? row.content.trim().slice(0, 2_000) : "",
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
