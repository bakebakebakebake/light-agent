const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; Light-Agent/0.4; +https://github.com/bakebakebakebake/light-agent)";

export type SearchBias = "general" | "technical" | "recent";
export type SearchBackend = "auto" | "tavily" | "bing";

export interface WebSearchResult {
  title: string;
  url: string;
  source: string;
  snippet: string;
  publishedAt?: string;
  backend: Exclude<SearchBackend, "auto">;
  score: number;
}

export interface SearchWebOptions {
  limit?: number;
  bias?: SearchBias;
  backend?: SearchBackend;
}

export interface FetchWebPageOptions {
  maxChars?: number;
}

interface SearchCandidate {
  title: string;
  url: string;
  source: string;
  snippet: string;
  publishedAt?: string;
  backend: Exclude<SearchBackend, "auto">;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text: string): string {
  return decodeEntities(
    text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function sourceOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function rewrittenQueries(query: string, bias: SearchBias): string[] {
  const queries = [query.trim()];
  const lower = query.toLowerCase();
  if (bias === "technical" && !/\bofficial|docs?|api|reference\b/.test(lower)) {
    queries.push(`${query} official docs`);
    queries.push(`${query} github`);
  }
  if (bias === "recent" && !/\blatest|today|recent|news|202\d\b/.test(lower)) {
    queries.push(`${query} latest`);
  }
  return [...new Set(queries.filter(Boolean))];
}

function termList(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}@._/-]+/u).filter(Boolean);
}

function coverageScore(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let score = 0;
  let covered = 0;
  for (const term of terms) {
    if (hay === term) score += 90;
    else if (hay.startsWith(term)) score += 50;
    else if (hay.includes(term)) score += 18;
    else continue;
    covered += 1;
  }
  return score + covered * 25;
}

function hostTrust(host: string, bias: SearchBias): number {
  const h = host.toLowerCase();
  let score = 0;
  if (/\bdocs?\./.test(h) || /developer\./.test(h) || /readthedocs|modelcontextprotocol/.test(h)) {
    score += bias === "technical" ? 80 : 24;
  }
  if (/github\.com|npmjs\.com|pypi\.org|crates\.io/.test(h)) {
    score += bias === "technical" ? 48 : 16;
  }
  if (/openai\.com|anthropic\.com|cloudflare\.com|react\.dev|nodejs\.org|python\.org|mozilla\.org|microsoft\.com/.test(h)) {
    score += bias === "technical" ? 70 : 22;
  }
  if (/stack(?:overflow|exchange)\.com|reddit\.com|medium\.com/.test(h)) {
    score -= bias === "technical" ? 20 : 6;
  }
  return score;
}

function recencyScore(publishedAt: string | undefined, bias: SearchBias): number {
  if (!publishedAt) return 0;
  const ts = Date.parse(publishedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = (Date.now() - ts) / 86_400_000;
  if (ageDays <= 3) return bias === "recent" ? 70 : 18;
  if (ageDays <= 14) return bias === "recent" ? 40 : 10;
  if (ageDays <= 45) return bias === "recent" ? 22 : 4;
  if (ageDays <= 120) return bias === "recent" ? 8 : 1;
  return 0;
}

function scoreResult(result: SearchCandidate, query: string, bias: SearchBias): number {
  const terms = termList(query);
  const title = result.title.toLowerCase();
  const text = `${result.title} ${result.snippet}`.toLowerCase();
  let score = 0;
  if (title === query.toLowerCase()) score += 140;
  if (title.includes(query.toLowerCase())) score += 80;
  score += coverageScore(result.title, terms) * 2;
  score += coverageScore(text, terms);
  score += hostTrust(result.source, bias);
  score += recencyScore(result.publishedAt, bias);
  if (result.backend === "tavily") score += 8;
  return score;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return await res.text();
}

async function searchWithTavily(query: string, opts: Required<Pick<SearchWebOptions, "limit" | "bias">>): Promise<SearchCandidate[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": DEFAULT_USER_AGENT,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: opts.bias === "technical" ? "advanced" : "basic",
      max_results: opts.limit,
      include_answer: false,
      include_images: false,
      include_raw_content: false,
      topic: opts.bias === "recent" ? "news" : "general",
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Tavily`);
  }
  const json = (await res.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }>;
  };
  return (json.results ?? [])
    .filter((item) => item.title && item.url)
    .map((item) => ({
      title: item.title!.trim(),
      url: item.url!.trim(),
      source: sourceOf(item.url!.trim()),
      snippet: (item.content ?? "").trim(),
      ...(item.published_date ? { publishedAt: item.published_date } : {}),
      backend: "tavily" as const,
    }));
}

async function searchWithBing(query: string, bias: SearchBias): Promise<SearchCandidate[]> {
  const merged = new Map<string, SearchCandidate>();
  for (const rewritten of rewrittenQueries(query, bias)) {
    const url =
      "https://www.bing.com/search?format=rss&setlang=en-US&q=" +
      encodeURIComponent(rewritten);
    const xml = await fetchText(url);
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    for (const item of items) {
      const title = stripHtml(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const link = decodeEntities(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? "").trim();
      const snippet = stripHtml(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "");
      const publishedAt = stripHtml(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? "");
      if (!title || !link) continue;
      const key = canonicalUrl(link);
      const current = merged.get(key);
      const next: SearchCandidate = {
        title,
        url: link,
        source: sourceOf(link),
        snippet,
        ...(publishedAt ? { publishedAt } : {}),
        backend: "bing",
      };
      if (!current || current.snippet.length < next.snippet.length) merged.set(key, next);
    }
  }
  return [...merged.values()];
}

function preferredBackend(explicit?: SearchBackend): SearchBackend {
  if (explicit && explicit !== "auto") return explicit;
  const fromEnv = (
    process.env.LIGHT_AGENT_SEARCH_BACKEND ??
    process.env.HARNESS_SEARCH_BACKEND ??
    "auto"
  )
    .trim()
    .toLowerCase();
  if (fromEnv === "tavily" || fromEnv === "bing") return fromEnv;
  return process.env.TAVILY_API_KEY ? "tavily" : "bing";
}

export async function searchWeb(
  query: string,
  opts: SearchWebOptions = {},
): Promise<WebSearchResult[]> {
  const limit = opts.limit ?? 5;
  const bias = opts.bias ?? "general";
  const backend = preferredBackend(opts.backend);

  let raw: SearchCandidate[];
  try {
    raw =
      backend === "tavily"
        ? await searchWithTavily(query, { limit, bias })
        : await searchWithBing(query, bias);
  } catch (err) {
    if (backend === "tavily") {
      raw = await searchWithBing(query, bias);
    } else {
      throw err;
    }
  }

  const merged = new Map<string, SearchCandidate>();
  for (const candidate of raw) {
    const key = canonicalUrl(candidate.url);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, candidate);
      continue;
    }
    if (candidate.backend === "tavily" && current.backend !== "tavily") {
      merged.set(key, candidate);
      continue;
    }
    if (candidate.snippet.length > current.snippet.length) merged.set(key, candidate);
  }

  return [...merged.values()]
    .map((result) => ({
      ...result,
      score: scoreResult(result, query, bias),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.source.localeCompare(b.source) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, limit);
}

export async function fetchWebPage(
  url: string,
  opts: FetchWebPageOptions = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? 12_000;
  const res = await fetch(url, {
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const raw = await res.text();
  const text = contentType.includes("html") ? stripHtml(raw) : raw.replace(/\s+/g, " ").trim();
  return text.length <= maxChars
    ? text
    : text.slice(0, maxChars) + `\n… [truncated at ${maxChars} chars]`;
}
