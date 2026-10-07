import type { SourceTemplate } from "../types";

// ---------------------------------------------------------------------------
// Rate-limit presets (verified constraints — see README "Known constraints").
// ---------------------------------------------------------------------------

/** Default politeness for ordinary, unconstrained feeds. */
export const RATE_DEFAULT = {
  minIntervalSeconds: 30,
  maxRequestsPerSecond: 1,
  requiresDescriptiveUserAgent: false,
  requiresApiKey: false,
} as const;

/** SEC EDGAR: descriptive User-Agent required; <=10 req/sec. */
export const RATE_EDGAR = {
  minIntervalSeconds: 0,
  maxRequestsPerSecond: 10,
  requiresDescriptiveUserAgent: true,
  requiresApiKey: false,
} as const;

/** Stack Exchange API: keyless quota is 300/day; a free key raises it to 10k/day. */
export const RATE_STACKEXCHANGE = {
  minIntervalSeconds: 0,
  maxRequestsPerSecond: 1,
  requiresDescriptiveUserAgent: false,
  requiresApiKey: true,
} as const;

/** Google News: poll no faster than ~15 min. */
export const RATE_GOOGLE_NEWS = {
  minIntervalSeconds: 900,
  maxRequestsPerSecond: 1,
  requiresDescriptiveUserAgent: false,
  requiresApiKey: false,
} as const;

// ---------------------------------------------------------------------------
// Expansion values (edit these arrays to add a competitor / tag / package —
// no code change required).
// ---------------------------------------------------------------------------

const GOOGLE_NEWS_QUERIES = [
  "AI developer tool",
  '"AI coding assistant"',
  '"Claude Code" OR "Cursor" OR "GitHub Copilot"',
  '"AI code review" OR "AI agent" OR "coding agent"',
];

const HN_KEYWORD_QUERIES = ["AI coding", "developer tools", "LLM"];

const STACKOVERFLOW_TAGS = ["langchain", "cursor", "llm"];

const STACKEXCHANGE_TAGS = ["langchain", "cursor", "llm"];

const DEVTO_TAGS = ["ai", "devtools"];

const YOUTUBE_CHANNELS: ReadonlyArray<{ channelId: string }> = [
  { channelId: "UC-placeholder-latent-space" },
  { channelId: "UC-placeholder-ai-engineer" },
];

const ALTERNATIVETO_SLUGS = ["cursor", "github-copilot", "claude"];

const NPM_PACKAGES = ["langchain", "@anthropic-ai/sdk", "ai"];

const PYPI_PACKAGES = ["langchain", "openai", "llama-index"];

const EDGAR_QUERIES = ["artificial intelligence coding", "developer tools"];

// ---------------------------------------------------------------------------
// Registry config. One concrete Source is produced per `expand` value.
// ---------------------------------------------------------------------------

export const SOURCE_REGISTRY: ReadonlyArray<SourceTemplate> = [
  // --- News: Google News RSS (universal fallback, query-template) ----------
  {
    id: "google-news",
    name: "Google News RSS",
    category: "news",
    accessMethod: "google_news",
    urlTemplate: "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en",
    pollIntervalMinutes: 20,
    signalType: "market-news",
    note: "Query-template. Encoded query is substituted. Poll no faster than ~15 min.",
    rateLimit: RATE_GOOGLE_NEWS,
    expand: GOOGLE_NEWS_QUERIES.map((query) => ({ query })),
  },

  // --- Community: Hacker News via hnrss.org (keyword-filtered) -------------
  {
    id: "hnrss-keyword",
    name: "Hacker News (keyword via hnrss)",
    category: "community",
    accessMethod: "rss",
    urlTemplate: "https://hnrss.org/newest?q={query}",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
    note: "Keyword-filtered HN feed.",
    expand: HN_KEYWORD_QUERIES.map((query) => ({ query })),
  },
  {
    id: "hnrss-show",
    name: "Hacker News Show",
    category: "community",
    accessMethod: "rss",
    url: "https://hnrss.org/show",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
    note: "Show HN via hnrss mirror.",
  },
  {
    id: "hn-front",
    name: "Hacker News Front Page",
    category: "community",
    accessMethod: "rss",
    url: "https://news.ycombinator.com/rss",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
  },
  {
    id: "hn-show",
    name: "Show HN",
    category: "community",
    accessMethod: "rss",
    url: "https://news.ycombinator.com/showrss",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
  },

  // --- Q&A: Stack Overflow feeds (tag-template) ---------------------------
  {
    id: "stackoverflow-all",
    name: "Stack Overflow (all)",
    category: "qa",
    accessMethod: "atom",
    url: "https://stackoverflow.com/feeds",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
  },
  {
    id: "stackoverflow-tag",
    name: "Stack Overflow (by tag)",
    category: "qa",
    accessMethod: "atom",
    urlTemplate: "https://stackoverflow.com/feeds/tag/{tag}",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
    expand: STACKOVERFLOW_TAGS.map((tag) => ({ tag })),
  },

  // --- Q&A: Stack Exchange API (key optional; see rate preset) ------------
  {
    id: "stackexchange",
    name: "Stack Exchange API (Stack Overflow)",
    category: "qa",
    accessMethod: "api",
    urlTemplate: "https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged={tag}",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
    note: "Set STACKEXCHANGE_KEY for 10k/day; keyless is 300/day and shared across all tags.",
    rateLimit: RATE_STACKEXCHANGE,
    expand: STACKEXCHANGE_TAGS.map((tag) => ({ tag })),
  },

  // --- Community: Dev.to ---------------------------------------------------
  {
    id: "devto-global",
    name: "DEV Community (global)",
    category: "community",
    accessMethod: "rss",
    url: "https://dev.to/feed",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
  },
  {
    id: "devto-tag",
    name: "DEV Community (by tag)",
    category: "community",
    accessMethod: "rss",
    urlTemplate: "https://dev.to/feed/tag/{tag}",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
    expand: DEVTO_TAGS.map((tag) => ({ tag })),
  },

  // --- Community: Lobsters ------------------------------------------------
  {
    id: "lobsters-all",
    name: "Lobsters (all)",
    category: "community",
    accessMethod: "rss",
    url: "https://lobste.rs/rss",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
  },
  {
    id: "lobsters-ai",
    name: "Lobsters (AI tag)",
    category: "community",
    accessMethod: "rss",
    url: "https://lobste.rs/t/ai.rss",
    pollIntervalMinutes: 20,
    signalType: "developer-discussion",
  },

  // --- Launches: Product Hunt Atom (NOT the GraphQL API) ------------------
  {
    id: "producthunt",
    name: "Product Hunt (Atom feed)",
    category: "launch",
    accessMethod: "atom",
    url: "https://www.producthunt.com/feed",
    pollIntervalMinutes: 20,
    signalType: "product-launch",
    note: "Atom feed only. The GraphQL API is prohibited for commercial use — do not add it.",
  },

  // --- Newsletters / blogs -------------------------------------------------
  {
    id: "tldr-ai",
    name: "TLDR AI",
    category: "news",
    accessMethod: "rss",
    url: "https://tldr.tech/api/rss/ai",
    pollIntervalMinutes: 60,
    signalType: "market-news",
  },
  {
    id: "latent-space",
    name: "Latent Space",
    category: "blog",
    accessMethod: "rss",
    url: "https://www.latent.space/feed",
    pollIntervalMinutes: 60,
    signalType: "vendor-content",
  },
  {
    id: "simon-willison",
    name: "Simon Willison",
    category: "blog",
    accessMethod: "atom",
    url: "https://simonwillison.net/atom/everything/",
    pollIntervalMinutes: 60,
    signalType: "vendor-content",
  },
  {
    id: "huggingface-blog",
    name: "Hugging Face Blog",
    category: "blog",
    accessMethod: "rss",
    url: "https://huggingface.co/blog/feed.xml",
    pollIntervalMinutes: 60,
    signalType: "vendor-content",
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "blog",
    accessMethod: "atom",
    url: "https://vercel.com/atom",
    pollIntervalMinutes: 60,
    signalType: "vendor-content",
  },
  {
    id: "github-blog",
    name: "GitHub Blog",
    category: "blog",
    accessMethod: "rss",
    url: "https://github.blog/feed/",
    pollIntervalMinutes: 60,
    signalType: "vendor-content",
  },
  {
    id: "langchain-blog",
    name: "LangChain Blog",
    category: "blog",
    accessMethod: "rss",
    url: "https://blog.langchain.dev/rss/",
    pollIntervalMinutes: 60,
    signalType: "vendor-content",
  },

  // --- Video: YouTube native channel feed (keyless) -----------------------
  {
    id: "youtube-channel",
    name: "YouTube (channel feed)",
    category: "video",
    accessMethod: "atom",
    urlTemplate: "https://www.youtube.com/feeds/videos.xml?channel_id={channelId}",
    pollIntervalMinutes: 60,
    signalType: "vendor-content",
    note: "Channel IDs are placeholders — replace with real IDs to activate.",
    expand: YOUTUBE_CHANNELS as ReadonlyArray<Record<string, string>>,
  },

  // --- Software alternatives ----------------------------------------------
  {
    id: "alternativeto",
    name: "AlternativeTo (per-software feed)",
    category: "launch",
    accessMethod: "rss",
    urlTemplate: "https://alternativeto.net/software/{slug}/feed/",
    pollIntervalMinutes: 120,
    signalType: "market-news",
    expand: ALTERNATIVETO_SLUGS.map((slug) => ({ slug })),
  },

  // --- Package adoption: npm + PyPI stats APIs ----------------------------
  {
    id: "npm-downloads",
    name: "npm downloads (last week)",
    category: "package-stats",
    accessMethod: "api",
    urlTemplate: "https://api.npmjs.org/downloads/point/last-week/{pkg}",
    pollIntervalMinutes: 360,
    signalType: "package-adoption",
    expand: NPM_PACKAGES.map((pkg) => ({ pkg })),
  },
  {
    id: "pypi-stats",
    name: "PyPI stats (recent)",
    category: "package-stats",
    accessMethod: "api",
    urlTemplate: "https://pypistats.org/api/packages/{pkg}/recent",
    pollIntervalMinutes: 360,
    signalType: "package-adoption",
    expand: PYPI_PACKAGES.map((pkg) => ({ pkg })),
  },

  // --- Regulatory: SEC EDGAR full-text search -----------------------------
  {
    id: "sec-edgar",
    name: "SEC EDGAR full-text search (form D)",
    category: "regulatory",
    accessMethod: "api",
    urlTemplate: "https://efts.sec.gov/LATEST/search-index?q={query}&forms=D",
    pollIntervalMinutes: 1440,
    signalType: "regulatory-filing",
    note: "Descriptive User-Agent required (set EDGAR_USER_AGENT). <=10 req/sec.",
    rateLimit: RATE_EDGAR,
    expand: EDGAR_QUERIES.map((query) => ({ query })),
  },

  // --- Signal layer: Grok-driven X scanner (push, not polled) -------------
  // This source is NOT fetched by the normal poller. It exists so the scanner's
  // `ingest-signal` messages pass the registry check and so classification /
  // attribution have a real source row. `enabled: false` keeps the 5-minute
  // poller from ever trying to GET it; the scanner writes through the queue seam
  // and is gated by its own SCANNER_ENABLED switch (see src/scan/*).
  {
    id: "grok-x-scanner",
    name: "Grok X scanner",
    category: "community",
    accessMethod: "api",
    url: "https://x.com",
    pollIntervalMinutes: 240,
    signalType: "competitor-mention",
    enabled: false,
    note: "Pushed by the 4-hourly Grok X scanner (SCANNER_ENABLED). Not polled directly.",
  },
];
