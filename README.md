# vantage-ingest

**An open-source GTM signal pipeline for the AI developer-tools market.**

Ingests many sources (feeds, community sites, package stats, filings), normalizes
them into one schema, deduplicates, classifies them with a batched LLM, and stores
the result in Postgres — so you can see what the market is launching, complaining
about, and asking for, without paying incumbent-monitoring prices.

Runs on **Cloudflare Workers + Cron Triggers + Queues** with **Neon Postgres**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> There is no test/build CI workflow yet, so no CI badge is shown. The only
> workflow in the repo is the OpenCode PR-automation workflow. Add a
> `typecheck` + `smoke` workflow (see [CONTRIBUTING.md](CONTRIBUTING.md)) and a
> badge alongside it if you want CI status surfaced.

---

## Why

Go-to-market monitoring for developer tools is sold at enterprise prices. Most of
the underlying work is public data: RSS feeds, community posts, package-download
stats, SEC filings. This project is the open-source core of an affordable way to
run that pipeline yourself — bring your own Neon database and an OpenAI-compatible
inference key, deploy to Cloudflare, and own your data and your signal.

The open-source core is **vantage-ingest**. A hosted, "affordable website" offering
is planned alongside it for people who would rather not self-host; the code in this
repository does not require it and stores nothing outside your own database.

---

## Features

- **Sourced signal pipeline** — one registry of sources (RSS/Atom feeds, JSON APIs,
  Google News, package stats, SEC EDGAR) that the cron trigger polls on per-source
  intervals, with conditional GET (ETag / Last-Modified) so unchanged feeds cost no
  work.
- **Three-layer deduplication** — canonical URL normalization, an in-batch pass, and
  Postgres unique constraints that make inserts idempotent.
- **Batched LLM classification** — labels (`launch`, `complaint`, `feature_request`,
  `funding`, `sentiment`, `chatter`, `noise`), a 0–1 relevance score, and raw entity
  mentions, produced in bounded batches on a queue that is fully decoupled from
  ingest.
- **Deterministic entity resolution** — an alias map canonicalizes the mentions the
  model suggests. The model never decides identity.
- **Non-destructive cross-source clustering** — the same headline across two or more
  distinct sources is surfaced as an advisory "multi-source echo" hint. Rows are never
  deleted or merged.
- **Extensible source registry** — add a competitor query, tag, or package by editing
  one config file. No code changes.

---

## Architecture

```
        Cloudflare Cron (every 5 min, and every 4 h)
                 |
                 | 5-min tick: poller enqueues due sources
                 | 4-h tick:   scanner (if enabled) enqueues X signals
                 v
        +-----------------+     one message     +-----------------------+
        |   runPoller     | ------------------> |  Queue: gtm-ingest-   |
        |  (enqueue only) |    per due source   |  jobs  (+ DLQ)        |
        +-----------------+                     +-----------+-----------+
                                                             |
        +-----------------+   ingest-signal messages          |
        |  runScanner     | --------------------  ------------+
        |  (Grok X scan)  |                                  |
        +-----------------+                                  v
                                    +-------------------------------------------+
                                    |  Consumer: fetch -> normalize -> dedup -> |
                                    |  insert into Neon                         |
                                    +---------------------+---------------------+
                                                          |
                                       (if classifier on) chunks of inserted ids
                                                          |
                                                          v
                                            +-----------------------------+
                                            |  Queue: gtm-classify-jobs   |
                                            |  (+ DLQ)                    |
                                            +--------------+--------------+
                                                           |
                                                           v
                                    +-------------------------------------------+
                                    |  Consumer: load unclassified -> chunk ->  |
                                    |  LLM classify -> repair -> entities ->    |
                                    |  persist -> cluster                       |
                                    +---------------------+---------------------+
                                                          |
                                                          v
                                                   +-------------+
                                                   | Neon        |
                                                   | Postgres    |
                                                   +-------------+
```

The cron handler **never** fetches upstream. It syncs the registry mirror, selects
which sources are due, and enqueues one message per due source. All fetching,
parsing, and writing happens in the queue consumer, so the fast trigger path stays
fast and each source retries independently. Classification runs on its own queue so
LLM latency or cost can never affect ingestion.

A second, four-hourly cron runs the **Grok X scanner**: it asks a model for new X
signals, validates them, and enqueues them as `ingest-signal` messages on the *same*
ingest queue. They therefore flow through the identical normalize → dedup → `items`
→ classify path as every other source. The scanner has no separate database path.

### Layout

| Path | Purpose |
|------|---------|
| `wrangler.toml` | cron trigger, queue producers + consumers, DLQs, non-secret vars |
| `src/types.ts` | shared trusted types + the queue contract + `Env` |
| `src/registry/seed.ts` | the seed source registry (config, not code) |
| `src/registry/index.ts` | expand/validate the registry, `findSource` |
| `src/poller.ts` | cron → due selection → `sendBatch` |
| `src/consumer.ts` | queue handler: fetch → normalize → dedup → write |
| `src/fetcher.ts` | conditional GET, per-source User-Agent, API-key injection |
| `src/normalizer.ts` | RSS/Atom/JSON → common shape, canonical URL + hashing |
| `src/db.ts` | Neon serverless queries + idempotent inserts |
| `src/index.ts` | Worker entry: `scheduled`, `queue`, and the small HTTP surface |
| `src/classify/*` | batched classification: handler, prompt, schema, config, policy |
| `src/entities/*` | alias map (entity resolution) + cross-source clustering |
| `src/inco/client.ts` | OpenAI-compatible chat client |
| `src/queue.ts` | queue message construction + UTF-8 byte-budget chunking (shared by `/signals` and the scanner) |
| `src/scan/*` | Grok X scanner: config, prompt, zod schema, mapping, orchestration |
| `migrations/*.sql` | schema, applied in filename order |
| `scripts/migrate.mjs` | apply migrations to Neon over HTTP |
| `scripts/smoke.ts` | pure-logic tests (no network/DB) |

---

## Quick start (self-host)

### Prerequisites

- **Node.js 18+** (the toolchain uses `tsx` and `wrangler`).
- A **Cloudflare account** with **Workers** and **Queues** enabled (Queues require
  a paid plan).
- A **Neon Postgres** database (or any Postgres reachable over the HTTP driver).
- An **OpenAI-compatible inference endpoint** for the signal layer. The defaults
  target `https://api.inco.ai/v1`; any compatible provider works by setting the model
  ids and key.

### 1. Install

```bash
npm install
```

### 2. Create the queues (one-time, per account)

```bash
npx wrangler queues create gtm-ingest-jobs
npx wrangler queues create gtm-ingest-jobs-dlq
npx wrangler queues create gtm-classify-jobs
npx wrangler queues create gtm-classify-jobs-dlq
```

### 3. Set secrets

Secrets are never read from a committed file. Set each with `wrangler secret put`
and paste the value at the prompt:

```bash
npx wrangler secret put DATABASE_URL          # Neon pooled conn string, sslmode=require
npx wrangler secret put INCO_API_KEY          # inference key for the signal layer
npx wrangler secret put MANUAL_TRIGGER_TOKEN  # bearer token for /trigger and /signals
npx wrangler secret put EDGAR_USER_AGENT      # descriptive UA, e.g. "GTM-Monitor/0.1 (you@example.com)"
npx wrangler secret put STACKEXCHANGE_KEY     # optional; raises quota 300/day -> 10k/day
```

`.env.example` lists every variable the code reads, with placeholder values and
comments. It is a reference template, not a secrets file — do not put real keys in
it.

### 4. Apply the schema

```bash
# PowerShell
$env:DATABASE_URL="postgres://..."; npm run migrate

# bash
DATABASE_URL="postgres://..." npm run migrate
```

### 5. Deploy

```bash
npm run deploy
```

Run locally with `npm run dev` (cron and queues are both simulated locally). Verify
the pure logic with no network or database: `npm run smoke`.

---

## Configuration

### Sources

Sources live in `src/registry/seed.ts` as configuration, not code. Edit the file:

- **Plain feed** — add an entry with a `url`.
- **Template** — add an entry with a `urlTemplate` containing `{tokens}` and an
  `expand` array of `{ token: value }` rows. Each row becomes one concrete source
  with a stable id like `template-id:slug`. To add a competitor query, append to the
  relevant array (`GOOGLE_NEWS_QUERIES`, `STACKOVERFLOW_TAGS`, `NPM_PACKAGES`, …).

On the next cron tick the poller syncs the registry into the `sources` table (without
clobbering ETag or `lastPolledAt`) and starts polling new entries. The expansion is
validated at parse time: an unknown placeholder, a duplicate id, or a malformed entry
fails loudly rather than silently dropping a source.

Inspect the live registry with `GET /sources`; check liveness with `GET /health`.

### Classifier knobs

| Var | Default | Meaning |
|-----|---------|---------|
| `CLASSIFIER_ENABLED` | `"true"` | Master switch. `"false"` disables all LLM work. |
| `INCO_API_KEY` | — | Inference key. Secret; read only from `env.INCO_API_KEY`. |
| `INCO_CLASSIFIER_MODEL` | `"deepseek-v4.1-flash"` | Classifier model id. |
| `INCO_WRITER_MODEL` | `"kimi-k3"` | Writer model id (reserved seam; see Roadmap). |
| `CLASSIFIER_BATCH_SIZE` | `15` | Items per LLM call. |
| `CLASSIFIER_MAX_ITEMS_PER_MESSAGE` | `60` | Hard cap of items classified per queue message (cost guardrail). |
| `CLASSIFIER_MAX_CONCURRENCY` | `2` | Max concurrent in-flight LLM calls per message. |

Disable the signal layer entirely by setting `CLASSIFIER_ENABLED = "false"`. Ingest
keeps running; no `classify-batch` messages are produced and no model is called.
Non-secret vars live in `wrangler.toml` under `[vars]`; the model ids were verified
against `GET https://api.inco.ai/v1/models` on 2026-10-07.

### Grok X scanner

The scanner asks an X-data-savvy model, on a **four-hourly** Cloudflare Cron Trigger
(`0 */4 * * *`), for new signals about the AI developer tools you track. It uses the
same OpenAI-compatible client as the classifier and pushes results through the
existing ingest seam: validated signals are enqueued as `ingest-signal` messages and
then normalized, deduplicated, written to `items`, and classified exactly like every
other source. **There is no separate database.** It is **off by default**.

Enable it:

1. Set a real scanner model id in `wrangler.toml` under `[vars]` (or as a Worker
   secret): `INCO_SCANNER_MODEL = "<your-x-scanning-model-id>"`. The default is a
   placeholder, and the scanner **refuses to run** while it is unset — so it never
   spends on the wrong capability.
2. Set `SCANNER_ENABLED = "true"`.
3. Ensure `INCO_API_KEY` is set (the scanner shares the classifier's key).

| Var | Default | Meaning |
|-----|---------|---------|
| `SCANNER_ENABLED` | `"false"` | Kill switch. `"true"` enables the four-hourly scan. |
| `INCO_SCANNER_MODEL` | placeholder | The X-scanning model id. **Must be set** to run. |
| `SCANNER_TRACKED_ENTITIES` | a default list | Comma-separated competitors/products (also your own product). Edit to watch a new competitor — no code change. |
| `SCANNER_TRACKED_KEYWORDS` | a default list | Comma-separated themes to watch for. |
| `SCANNER_MAX_ITEMS_PER_SCAN` | `25` | Hard cap on signals enqueued per scan (cost guardrail). |

The tracked lists also have editable defaults in `src/scan/config.ts`. The scanner
registers a source (`grok-x-scanner`) in `src/registry/seed.ts`; it is `enabled:false`
so the normal poller never GETs it, but it exists so the `/signals` seam and
classification attribution accept its rows.

**Schedule.** The four-hourly trigger lives in `wrangler.toml` under `[triggers]`.
The Worker has one `scheduled` handler that dispatches on `event.cron`: the frequent
tick runs the poller, the four-hourly tick runs `runScanner`.

**Idempotency & cost.** Repeated scans do not spam duplicates: signals are de-duped
in-batch and against a bounded rolling set of stable keys (URL-canonical when present,
else normalized title) persisted in the `meta` table — on top of the database's own
`(source_id, canonical_url)` / `(source_id, title_hash)` dedup. Each scan logs one
structured audit line (`event: "scan.complete"`) with `scanned`, `enqueued`, and
`rejected` counts, plus token usage. The API key is read only from `env.INCO_API_KEY`
and never logged.

### Manual triggers

Poll a single source on demand:

```bash
curl -X POST https://gtm-ingest.<subdomain>.workers.dev/trigger/google-news:ai-developer-tool \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN"
```

Expansion ids are `template-id:slug`, e.g. `stackoverflow-tag:cursor`,
`npm-downloads:langchain`, `google-news:ai-developer-tool`.

---

## Design principles

These are deliberate, load-bearing choices — not accidents. Each one exists to make a
failure mode safe.

**Non-destructive cluster hints, not merges.** Matching headlines on a title hash can
over-merge (syndicated copy, wire repeats). So clustering never deletes or merges
rows: each item keeps its own id, and a cluster is only formed when the same title
hash appears across **two or more distinct sources**. Membership is recomputed over a
sliding window, and stale stamps are cleared when a cluster stops being corroborated.

**Version-keyed re-classification.** New items are always classified; already-classified
items are re-classified only on an explicit version bump. The load step selects rows that
are either never classified or **version-stale** (`classifier_version` differs from the
current `CLASSIFIER_PROMPT_VERSION`), and the write guard is first-writer-wins at the same
version — so a stale or re-delivered writer cannot clobber a newer result, while a
deliberate `CLASSIFIER_PROMPT_VERSION` change re-classifies exactly the stale rows once.
Because each write stamps the incoming version, the stale set drains after a single pass
and does not re-bill on the next run. A `classification_status` column distinguishes a real
classification from a parse-failure fallback, so failed rows can be swept and retried later.

**Bounded LLM repair.** If the model's reply omits or mangles some indices, the handler
makes exactly ONE repair call for the missing indices. A repair reply whose index set
is not a clean subset of the ones requested is rejected wholesale — a misnumbered
reply must never label the wrong row. Anything still missing falls back to a
well-formed `unclassified`, never a half-written batch.

**Classification never touches ingest.** It runs on a separate queue. If the
inference provider is slow, down, or over budget, fetch → normalize → write keeps
running uninterrupted.

**Deterministic entity resolution.** The model only suggests raw mentions copied from
the text. A versioned alias map in code canonicalizes them, so every merge is
auditable and reproducible, and entity identity never depends on a model's judgment.

---

## Roadmap

Planned work, clearly separated from what already ships:

- **Grok X scanner (shipped).** A four-hourly scan of X (via Grok) that pushes
  signals through the existing ingest path. Enable it with `SCANNER_ENABLED = "true"`
  and a real `INCO_SCANNER_MODEL`; edit `SCANNER_TRACKED_ENTITIES` to change what it
  watches. It reuses the `ingest-signal` seam, the normalizer, the same `items` table,
  and the classify queue — no separate database. See "Grok X scanner" above. The
  `POST /signals/:sourceId` endpoint remains available for manual pushes.
- **Human-in-the-loop earned-media drafting agent (planned).** A drafting agent that
  uses Cloudflare's Agents SDK to turn strong signals into draft posts for review.
  It is designed to be **human-in-the-loop and disclosed**: a draft is produced, a
  human reviews it, and nothing is posted without explicit approval. It is not
  automated astroturfing, and it will not post on its own.
- **More sources (ongoing).** Additional feeds, APIs, and regions, added through the
  registry.

---

## Known constraints

- **Cloudflare Queues require a paid plan.** `wrangler.toml` declares the producers,
  consumers, and dead-letter queues; local dev simulates both sides.
- **`pg` cannot run in a Worker.** All database access goes through
  `@neondatabase/serverless`'s HTTP driver.
- **No global per-host rate limiter yet.** Politeness is enforced by per-source poll
  intervals and a per-source minimum interval. Because queue consumers run
  concurrently, this is not a hard global cap on requests to a single host. Revisit at
  roughly 100 sources or when many sources share one host.
- **SSRF is a latent risk.** Source URLs come from the config registry, which is
  treated as trusted operator input, and the fetcher does not restrict the destination
  host. This is safe only while the registry is code-reviewed config. If the registry
  ever becomes remotely editable, add a destination allow/deny policy first.
- **Some seeded sources use placeholder values.** YouTube channel IDs and a few
  registry entries expand from placeholders; replace them with real values to activate.
  Until then they fetch and simply return no items.
- **`DEFAULT_POLL_INTERVAL_MINUTES` is declared but not read.** Per-source intervals in
  `src/registry/seed.ts` drive scheduling in practice; the global fallback is currently
  inert.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project uses OpenCode for GitHub PR
automation — mention `/oc` in a comment to invoke it.

## License

[MIT](LICENSE) © 2026 sodown4thecause
