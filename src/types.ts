// Shared types. Data crossing process boundaries (registry config, HTTP responses,
// queue messages) is *parsed* into these trusted types by the parsers in
// `registry.ts`, `normalizer.ts`, and `queue.ts`. Internal code trusts them.

/** How a source is reached. Drives which fetcher/parser the consumer picks. */
export type AccessMethod = "rss" | "atom" | "api" | "google_news" | "rsshub";

/** Coarse bucket used for routing and later classification. */
export type SourceCategory =
  | "news"
  | "community"
  | "qa"
  | "launch"
  | "blog"
  | "video"
  | "package-stats"
  | "regulatory";

/**
 * The human-meaningful signal this source contributes. Kept as a closed union so
 * downstream consumers can switch exhaustively and illegal values fail at parse.
 */
export type SignalType =
  | "market-news"
  | "competitor-mention"
  | "developer-discussion"
  | "product-launch"
  | "vendor-content"
  | "package-adoption"
  | "regulatory-filing";

/** A concrete, ready-to-poll source with all templates expanded. */
export interface Source {
  readonly id: string;
  readonly name: string;
  readonly category: SourceCategory;
  readonly accessMethod: AccessMethod;
  /** Fully-resolved URL. Template placeholders are already substituted. */
  readonly url: string;
  readonly pollIntervalMinutes: number;
  readonly signalType: SignalType;
  readonly enabled: boolean;
  /** Free-form operator note; surfaced in logs and the registry audit. */
  readonly note?: string;
  /**
   * Per-source opt-in query params to strip during canonicalization, in addition
   * to the global tracking set (`utm_*`/`fbclid`/`gclid`). Use for params like
   * `ref`/`source` that are tracking noise on one site but meaningful elsewhere.
   */
  readonly stripParams?: ReadonlyArray<string>;
  /**
   * Politeness overrides. Absent values fall back to global defaults.
   * `minIntervalSeconds` is a hard floor between consecutive requests to the
   * same host, independent of `pollIntervalMinutes`.
   */
  readonly rateLimit?: RateLimitPolicy;
}

export interface RateLimitPolicy {
  /** Hard minimum seconds between requests to this source's host. */
  readonly minIntervalSeconds: number;
  /** Max requests per second permitted to the host (SEC EDGAR = 10). */
  readonly maxRequestsPerSecond: number;
  /** Requires a descriptive User-Agent (SEC EDGAR). */
  readonly requiresDescriptiveUserAgent: boolean;
  /** Requires an API key for usable quota (Stack Exchange). */
  readonly requiresApiKey: boolean;
}

/**
 * A template entry in the registry config. It expands (usually 1..N) into
 * concrete `Source`s via `expandRegistry()`. Templates keep "add a competitor
 * query" a config edit, not a code change.
 */
export interface SourceTemplate {
  readonly id: string;
  readonly name: string;
  readonly category: SourceCategory;
  readonly accessMethod: AccessMethod;
  /** URL containing `{placeholder}` tokens, e.g. `.../search?q={query}`. */
  readonly urlTemplate?: string;
  /** For plain (non-templated) sources. Exactly one of url/urlTemplate is set. */
  readonly url?: string;
  readonly pollIntervalMinutes?: number;
  readonly signalType: SignalType;
  readonly enabled?: boolean;
  readonly note?: string;
  readonly rateLimit?: RateLimitPolicy;
  /** Per-source opt-in query params to strip; see `Source.stripParams`. */
  readonly stripParams?: ReadonlyArray<string>;
  /**
   * Values substituted into `{placeholder}` tokens. One concrete Source per
   * value, with `{key}` replaced. Empty/absent => no expansion (url must be set).
   */
  readonly expand?: ReadonlyArray<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Normalized item
// ---------------------------------------------------------------------------

/** The common shape every source normalizes into before it hits Neon. */
export interface NormalizedItem {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly category: SourceCategory;
  readonly title: string;
  readonly url: string;
  readonly author: string | null;
  /** ISO-8601 UTC, or null when the feed provides no usable date. */
  readonly publishedAt: string | null;
  readonly summary: string | null;
  /** Canonical URL used for primary dedup. */
  readonly canonicalUrl: string;
  /** sha-256 of (sourceId + normalized title), used for per-source secondary dedup. */
  readonly titleHash: string;
  /**
   * sha-256 of the normalized title ALONE (unscoped by source). Persisted now so
   * cross-source collapsing (same article via Google News + vendor blog + HN)
   * can be built in the classification/entity-resolution phase without a costly
   * backfill. Not used for dedup yet.
   */
  readonly globalTitleHash: string;
  /** sha-256 of (canonicalUrl + title + summary), used to detect edits. */
  readonly contentHash: string;
  readonly rawContent: string;
  readonly fetchedAt: string;
  readonly signalTags: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Queue message contract
// ---------------------------------------------------------------------------

export type QueueMessage =
  | { readonly kind: "poll-source"; readonly sourceId: string; readonly enqueuedAt: string }
  | {
      // Clean seam for the deferred Grok/X scanner: it POSTs normalized signals
      // that reuse the exact same `items` table + dedup path.
      readonly kind: "ingest-signal";
      readonly sourceId: string;
      readonly enqueuedAt: string;
      readonly items: ReadonlyArray<RawSignal>;
    }
  | {
      // Decoupled classification work. Produced after items are inserted; a
      // separate consumer path classifies a bounded batch of item ids. Keeping
      // this off the ingest path means classification latency/cost never affects
      // fetching, and a classifier outage cannot fail ingest.
      readonly kind: "classify-batch";
      readonly enqueuedAt: string;
      /** Item ids to classify. Already-classified rows are skipped by the handler. */
      readonly itemIds: ReadonlyArray<number>;
    };

/** Operator-supplied signal (future Grok/X scanner, manual backfill). */
export interface RawSignal {
  readonly title: string;
  readonly url: string;
  readonly author?: string;
  readonly publishedAt?: string;
  readonly summary?: string;
  readonly rawContent?: string;
  readonly signalTags?: ReadonlyArray<string>;
}

/** Environment bindings, injected by the Workers runtime. */
export interface Env {
  readonly INGEST_QUEUE: Queue<QueueMessage>;
  /** Producer for the decoupled classification queue. */
  readonly CLASSIFY_QUEUE: Queue<QueueMessage>;
  readonly DATABASE_URL: string;
  readonly STACKEXCHANGE_KEY?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
  readonly EDGAR_USER_AGENT?: string;
  readonly DEFAULT_POLL_INTERVAL_MINUTES: string;
  readonly USER_AGENT: string;

  // --- Signal layer (classification) ---------------------------------------
  /** inferAPI key. Required only when classification is enabled. Secret. */
  readonly INCO_API_KEY?: string;
  /** Master switch. "false" disables all classification work. Default enabled. */
  readonly CLASSIFIER_ENABLED?: string;
  /** Classifier model id (DeepSeek V4.1 Flash). Defaults in `src/classify/config.ts`. */
  readonly INCO_CLASSIFIER_MODEL?: string;
  /** Writer model id (Kimi K3). Reserved seam; drafted features are a later phase. */
  readonly INCO_WRITER_MODEL?: string;
  /** Items per LLM call. */
  readonly CLASSIFIER_BATCH_SIZE?: string;
  /** Hard cap on items classified per queue message (cost guardrail). */
  readonly CLASSIFIER_MAX_ITEMS_PER_MESSAGE?: string;
  /** Max concurrent in-flight LLM calls within one message. */
  readonly CLASSIFIER_MAX_CONCURRENCY?: string;

  // --- Signal layer (Grok X scanner) ---------------------------------------
  /** Kill switch. "true" enables the 4-hourly scan; anything else (or absent) is off. */
  readonly SCANNER_ENABLED?: string;
  /**
   * Scanner model id (the X-scanning model). Defaults to an unusable placeholder
   * in `src/scan/config.ts`; the scanner refuses to run until it is set.
   */
  readonly INCO_SCANNER_MODEL?: string;
  /** Comma-separated tracked entities/products. Defaults in `src/scan/config.ts`. */
  readonly SCANNER_TRACKED_ENTITIES?: string;
  /** Comma-separated tracked keywords/themes. Defaults in `src/scan/config.ts`. */
  readonly SCANNER_TRACKED_KEYWORDS?: string;
  /** Hard cap on signals enqueued per scan (cost guardrail). */
  readonly SCANNER_MAX_ITEMS_PER_SCAN?: string;
}
