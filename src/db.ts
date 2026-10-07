import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { NormalizedItem, Source } from "./types";
import type { ReconciledItem } from "./classify/batch";
import type { ClusterableItem, ClusterHint } from "./entities/cluster";
import type { SignalLabel } from "./classify/schema";

// ---------------------------------------------------------------------------
// Neon over HTTP. In a Worker there is no TCP socket for `pg`; the Neon serverless
// driver speaks Postgres over HTTP(S). This is the ONLY supported DB transport
// here — do not swap in `pg` / `postgres`.
// ---------------------------------------------------------------------------

let cachedSql: NeonQueryFunction<false, false> | undefined;

function sql(databaseUrl: string): NeonQueryFunction<false, false> {
  cachedSql ??= neon(databaseUrl);
  return cachedSql;
}

/** Registry row read from the `sources` table (conditional-GET state). */
export interface SourceState {
  readonly id: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly lastPolledAt: string | null;
}

export interface IngestResult {
  /** Rows actually inserted (dedup survivors). */
  readonly inserted: number;
  /** Rows offered to the DB (pre-dedup). */
  readonly offered: number;
  /** Primary keys of inserted rows, used to enqueue classification work. */
  readonly insertedIds: ReadonlyArray<number>;
}

/** The slice of a source that `syncSources` persists, in a stable string form. */
function fingerprintSource(source: Source): string {
  return JSON.stringify([
    source.id,
    source.name,
    source.category,
    source.accessMethod,
    source.url,
    source.pollIntervalMinutes,
    source.signalType,
    source.enabled,
    source.note ?? null,
    source.stripParams ?? null,
  ]);
}

/**
 * A deterministic digest of the expanded registry's persisted fields. Equal
 * fingerprints mean a `syncSources` write would be a no-op, so the poller can
 * skip it. Uses the same SHA-256 used elsewhere (webcrypto only).
 */
export async function registryFingerprint(
  sources: ReadonlyArray<Source>,
): Promise<string> {
  const canonical = sources.map(fingerprintSource).sort().join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const REGISTRY_FINGERPRINT_KEY = "registry_fingerprint";

/** Read the last-synced registry fingerprint, or null when never synced. */
export async function loadRegistryFingerprint(databaseUrl: string): Promise<string | null> {
  const db = sql(databaseUrl);
  const rows = await db`
    select value from meta where key = ${REGISTRY_FINGERPRINT_KEY}
  `;
  return (rows[0]?.value as string | undefined) ?? null;
}

/** Persist the registry fingerprint after a successful sync. */
export async function saveRegistryFingerprint(
  databaseUrl: string,
  fingerprint: string,
): Promise<void> {
  const db = sql(databaseUrl);
  await db`
    insert into meta (key, value, updated_at)
    values (${REGISTRY_FINGERPRINT_KEY}, ${fingerprint}, now())
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
  `;
}

/** `meta` key holding the scanner's recent-window dedup key set. */
const SCANNER_SEEN_KEYS_META_KEY = "scanner_seen_keys";

/**
 * Load the scanner's recent-window dedup key set from the `meta` table.
 *
 * This is a small rolling SET of stable per-signal keys (see
 * `scannerDedupKey`), NOT an item store: it exists only so back-to-back scans
 * skip re-enqueuing the same post. It is bounded by the scanner when written, so
 * this read stays cheap. A missing/corrupt value reads as an empty set (the
 * scanner then falls back to the DB's own dedup), never as an error.
 */
export async function loadScannerSeenKeys(databaseUrl: string): Promise<ReadonlySet<string>> {
  const db = sql(databaseUrl);
  const rows = await db`
    select value from meta where key = ${SCANNER_SEEN_KEYS_META_KEY}
  `;
  const raw = rows[0]?.value as string | undefined;
  if (raw === undefined || raw === "") return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Persist the scanner's recent-window dedup key set. Best-effort by design:
 * losing the window only costs a redundant enqueue (the DB dedup still applies),
 * so a failed write must never fail a scan.
 */
export async function saveScannerSeenKeys(
  databaseUrl: string,
  keys: ReadonlyArray<string>,
): Promise<void> {
  const db = sql(databaseUrl);
  // Store as JSON text; the column is `text not null`. De-dup defensively.
  const payload = JSON.stringify([...new Set(keys)]);
  await db`
    insert into meta (key, value, updated_at)
    values (${SCANNER_SEEN_KEYS_META_KEY}, ${payload}, now())
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
  `;
}

/**
 * Upsert the registry into `sources` so the DB mirrors config. Idempotent;
 * never clobbers conditional-GET state (etag/lastModified/lastPolledAt).
 */
export async function syncSources(
  databaseUrl: string,
  sources: ReadonlyArray<Source>,
): Promise<void> {
  if (sources.length === 0) return;
  const db = sql(databaseUrl);
  const ids = sources.map((s) => s.id);
  const names = sources.map((s) => s.name);
  const categories = sources.map((s) => s.category);
  const methods = sources.map((s) => s.accessMethod);
  const urls = sources.map((s) => s.url);
  const intervals = sources.map((s) => s.pollIntervalMinutes);
  const signals = sources.map((s) => s.signalType);
  const enabled = sources.map((s) => s.enabled);
  const notes = sources.map((s) => s.note ?? null);
  // Mirror the resolved strip list faithfully: absent config becomes an empty
  // array (the column is `not null default '{}'`), so the DB reflects what the
  // in-memory registry actually uses during canonicalization.
  const stripParams = sources.map((s) => [...(s.stripParams ?? [])]);

  await db`
    insert into sources (id, name, category, access_method, url, poll_interval_minutes, signal_type, enabled, note, strip_params)
    select * from unnest(
      ${ids}::text[], ${names}::text[], ${categories}::text[], ${methods}::text[],
      ${urls}::text[], ${intervals}::int[], ${signals}::text[], ${enabled}::boolean[], ${notes}::text[],
      ${stripParams}::text[][]
    )
    on conflict (id) do update set
      name = excluded.name,
      category = excluded.category,
      access_method = excluded.access_method,
      url = excluded.url,
      poll_interval_minutes = excluded.poll_interval_minutes,
      signal_type = excluded.signal_type,
      enabled = excluded.enabled,
      note = excluded.note,
      strip_params = excluded.strip_params
  `;
}

/**
 * Disable a source in the DB mirror. Used when a feed is permanently gone (a
 * persistent 4xx): the config registry stays the source of truth, but the mirror
 * flips `enabled` so the audit trail reflects the runtime decision. The next
 * registry sync does not touch `enabled` for unchanged sources (it only writes on
 * fingerprint change), so this sticks until config changes.
 */
export async function disableSource(databaseUrl: string, sourceId: string): Promise<void> {
  const db = sql(databaseUrl);
  await db`
    update sources set enabled = false, updated_at = now() where id = ${sourceId}
  `;
}

/** Fetch conditional-GET + last-poll state for a batch of sources. */
export async function loadSourceStates(
  databaseUrl: string,
  sourceIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, SourceState>> {
  if (sourceIds.length === 0) return new Map();
  const db = sql(databaseUrl);
  const rows = await db`
    select id, etag, last_modified, last_polled_at
    from sources
    where id = any(${sourceIds}::text[])
  `;

  const states = new Map<string, SourceState>();
  for (const row of rows) {
    states.set(row.id as string, {
      id: row.id as string,
      etag: (row.etag as string | null) ?? null,
      lastModified: (row.last_modified as string | null) ?? null,
      lastPolledAt: (row.last_polled_at as string | null) ?? null,
    });
  }
  return states;
}

/**
 * Update lastPolledAt and the stored validator state. Validators are set to the
 * value the server just returned — including `null`, which CLEARS them. We must
 * not `coalesce` here: if a 200 response omits `etag`, the old validator is stale
 * and coalescing would freeze it forever (every later poll would send a bogus
 * If-None-Match and could get a wrong 304). Logs the transition for auditability.
 */
export async function recordPoll(
  databaseUrl: string,
  sourceId: string,
  etag: string | null,
  lastModified: string | null,
): Promise<void> {
  const db = sql(databaseUrl);
  const rows = await db`
    update sources
    set last_polled_at = now(),
        etag = ${etag},
        last_modified = ${lastModified}
    where id = ${sourceId}
    returning etag, last_modified
  `;
  const row = rows[0] as { etag: string | null; last_modified: string | null } | undefined;
  console.log(
    JSON.stringify({
      event: "source.validators",
      sourceId,
      // What was just written: a non-null value is "replaced", null is "cleared".
      etag: row?.etag ?? null,
      lastModified: row?.last_modified ?? null,
      cleared: row?.etag === null || row?.last_modified === null,
    }),
  );
}

/**
 * Collapse duplicates *within a batch* before the INSERT is built. A single
 * unnest INSERT with ON CONFLICT DO NOTHING is not guaranteed to catch two
 * duplicate rows inside the same statement (especially against a partial unique
 * index), so we dedup here as well, keyed on canonicalUrl first then titleHash.
 * The DB constraints remain the backstop across batches. Pure: returns a new
 * array, never mutates its input.
 */
export function dedupeBatch(items: ReadonlyArray<NormalizedItem>): ReadonlyArray<NormalizedItem> {
  const seenCanonicalUrls = new Set<string>();
  const seenTitleHashes = new Set<string>();
  const survivors: NormalizedItem[] = [];
  for (const item of items) {
    if (seenCanonicalUrls.has(item.canonicalUrl)) continue;
    if (item.titleHash !== "" && seenTitleHashes.has(item.titleHash)) continue;
    seenCanonicalUrls.add(item.canonicalUrl);
    if (item.titleHash !== "") seenTitleHashes.add(item.titleHash);
    survivors.push(item);
  }
  return survivors;
}

/**
 * Insert normalized items with idempotent dedup. Items are first collapsed
 * in-process by `dedupeBatch`; uniqueness across batches lives in the DB:
 *   - primary:  (source_id, canonical_url)
 *   - secondary:(source_id, title_hash) where title_hash is set
 * ON CONFLICT DO NOTHING makes re-polls safe. Returns inserted vs offered so the
 * caller can log a truthful dedup count.
 */
export async function insertItems(
  databaseUrl: string,
  items: ReadonlyArray<NormalizedItem>,
): Promise<IngestResult> {
  const survivors = dedupeBatch(items);
  if (survivors.length === 0) return { inserted: 0, offered: items.length, insertedIds: [] };

  const db = sql(databaseUrl);
  const sourceIds = survivors.map((i) => i.sourceId);
  const sourceNames = survivors.map((i) => i.sourceName);
  const categories = survivors.map((i) => i.category);
  const titles = survivors.map((i) => i.title);
  const urls = survivors.map((i) => i.url);
  const canonicalUrls = survivors.map((i) => i.canonicalUrl);
  const titleHashes = survivors.map((i) => i.titleHash);
  const globalTitleHashes = survivors.map((i) => i.globalTitleHash);
  const contentHashes = survivors.map((i) => i.contentHash);
  const authors = survivors.map((i) => i.author);
  const publishedAt = survivors.map((i) => i.publishedAt);
  const summaries = survivors.map((i) => i.summary);
  const rawContents = survivors.map((i) => i.rawContent);
  const fetchedAt = survivors.map((i) => i.fetchedAt);
  const signalTags = survivors.map((i) => i.signalTags as string[]);

  const rows = await db`
    insert into items (
      source_id, source_name, category, title, url, canonical_url, title_hash,
      global_title_hash, content_hash, author, published_at, summary, raw_content,
      fetched_at, signal_tags
    )
    select * from unnest(
      ${sourceIds}::text[], ${sourceNames}::text[], ${categories}::text[],
      ${titles}::text[], ${urls}::text[], ${canonicalUrls}::text[], ${titleHashes}::text[],
      ${globalTitleHashes}::text[], ${contentHashes}::text[], ${authors}::text[],
      ${publishedAt}::timestamptz[], ${summaries}::text[], ${rawContents}::text[],
      ${fetchedAt}::timestamptz[], ${signalTags}::text[][]
    )
    on conflict do nothing
    returning id
  `;

  return {
    inserted: rows.length,
    offered: items.length,
    insertedIds: rows.map((row) => Number(row.id)),
  };
}

/** Append an audit row for a poll/fetch attempt. Never throws into the caller. */
export async function recordJob(
  databaseUrl: string,
  job: {
    readonly sourceId: string;
    readonly status: string;
    readonly httpStatus: number | null;
    readonly itemCount: number;
    readonly dedupedCount: number;
    readonly durationMs: number;
    readonly error: string | null;
  },
): Promise<void> {
  const db = sql(databaseUrl);
  await db`
    insert into jobs (source_id, status, http_status, item_count, deduped_count, duration_ms, error)
    values (${job.sourceId}, ${job.status}, ${job.httpStatus}, ${job.itemCount},
            ${job.dedupedCount}, ${job.durationMs}, ${job.error})
  `;
}

// ---------------------------------------------------------------------------
// Classification persistence.
//
// Idempotency is enforced at BOTH ends and is version-keyed:
//   - LOAD  selects rows that are unclassified (`classified_at is null`) OR
//     version-stale (`classifier_version is distinct from <current version>`).
//     A re-run at the same version finds nothing to do and re-bills nothing; a
//     deliberate version bump re-selects exactly the stale rows once.
//   - WRITE guards every row with `classified_at is null or classifier_version
//     is distinct from v.version`, so a stale writer can never clobber a newer
//     classification (first-writer-wins; a deliberate version bump overwrites).
// `classifier_version` is stored so a prompt/model bump can deliberately mark
// rows stale for re-classification. The LOAD predicate must therefore include
// stale rows or the documented "re-classified on an explicit version bump"
// policy would be unreachable. The two predicates converge after one pass: the
// write stamps the incoming version, so a just-bumped row no longer matches
// `classifier_version is distinct from <current version>` on the next load.
// See `src/classify/write-policy.ts` for the pure predicate that mirrors the
// WRITE guard, and README for the policy.
// ---------------------------------------------------------------------------

/** An item pulled from the DB and handed to the classifier. */
export interface ClassifierInputRow {
  readonly id: number;
  readonly sourceName: string;
  readonly title: string;
  readonly summary: string | null;
  readonly rawContent: string;
}

/**
 * Load the subset of the requested ids that still needs classifying at
 * `currentVersion`: either never classified (`classified_at is null`) or
 * version-stale (`classifier_version is distinct from currentVersion`).
 *
 * This is the idempotency guard: a re-delivered message at the same version
 * finds nothing to do and costs nothing, while a deliberate version bump
 * re-selects exactly the stale rows once. Returns rows in ascending id order.
 * Already-classified ids at the current version (and unknown ids) are silently
 * omitted.
 */
export async function loadUnclassifiedItems(
  databaseUrl: string,
  itemIds: ReadonlyArray<number>,
  currentVersion: string,
): Promise<ReadonlyArray<ClassifierInputRow>> {
  if (itemIds.length === 0) return [];
  const db = sql(databaseUrl);
  const rows = await db`
    select id, source_name, title, summary, raw_content
    from items
    where id = any(${itemIds}::bigint[])
      and (classified_at is null or classifier_version is distinct from ${currentVersion})
    order by id asc
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    sourceName: String(row.source_name),
    title: String(row.title),
    summary: (row.summary as string | null) ?? null,
    rawContent: String(row.raw_content),
  }));
}

/** A classification result to persist for one item. */
export interface ClassificationWrite {
  readonly id: number;
  readonly status: ReconciledItem["status"];
  readonly labels: ReadonlyArray<SignalLabel>;
  readonly entities: ReadonlyArray<string>;
  readonly relevance: number;
  readonly reason: string;
  readonly uncertain: ReadonlyArray<SignalLabel>;
  readonly model: string;
  readonly version: string;
}

/**
 * Persist classifications in one batched UPDATE. Rows are matched by id via
 * `unnest`, so it is a single round-trip regardless of batch size.
 *
 * The UPDATE is guarded so it is FIRST-WRITER-WINS and VERSION-ORDERED:
 *   `where i.id = v.id
 *      and (i.classified_at is null or i.classifier_version is distinct from v.version)`
 * A fresh row (classified_at null) is written; a row already at the same version
 * is left untouched (a re-delivered/stale writer cannot clobber it); a row at a
 * different version is overwritten (the deliberate re-classify path). Versions
 * are opaque tokens, not a linear order: `is distinct from` is the whole rule,
 * which is sufficient for the version-keyed policy. See
 * `src/classify/write-policy.ts` (`shouldWriteClassification`) for the pure
 * mirror of this predicate.
 *
 * `classification_status` records the OUTCOME (`classified` | `unclassified`)
 * so a transient parse-failure row can be swept and re-attempted later even
 * though `classified_at` is stamped (which alone prevents immediate re-billing).
 *
 * `signal_labels` is a convenience column for filtering; the full structured
 * payload (including entities, uncertainty, and model/version) lives in the
 * `classification` jsonb so the product can evolve without new columns.
 */
export async function saveClassifications(
  databaseUrl: string,
  writes: ReadonlyArray<ClassificationWrite>,
): Promise<number> {
  if (writes.length === 0) return 0;
  const db = sql(databaseUrl);
  const ids = writes.map((w) => w.id);
  const labels = writes.map((w) => [...w.labels]);
  const statuses = writes.map((w) => w.status);
  const versions = writes.map((w) => w.version);
  const payloads = writes.map((w) =>
    JSON.stringify({
      status: w.status,
      labels: w.labels,
      entities: w.entities,
      relevance: w.relevance,
      reason: w.reason,
      uncertain: w.uncertain,
      model: w.model,
      version: w.version,
    }),
  );

  const rows = await db`
    update items as i
    set signal_labels = v.labels,
        classification = v.payload::jsonb,
        classification_status = v.status,
        classified_at = now(),
        classifier_version = v.version
    from unnest(
      ${ids}::bigint[], ${labels}::text[][], ${statuses}::text[], ${versions}::text[], ${payloads}::text[]
    ) as v(id, labels, status, version, payload)
    where i.id = v.id
      and (i.classified_at is null or i.classifier_version is distinct from v.version)
    returning i.id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Entity persistence.
//
// `entities` is the canonical registry; `item_entities` is the many-to-many
// join with the raw mention preserved for audit. Resolution is deterministic:
// the alias map (config/code) decides identity; the LLM only suggests mentions.
// ---------------------------------------------------------------------------

/**
 * A canonical entity to upsert.
 *
 * `aliases` is the FULL desired alias set for the entity, computed in app code at
 * the call site — determinism over cleverness. The persistence layer still
 * unions with whatever is already stored (`entities.aliases || excluded.aliases`)
 * so concurrent writers cannot lose each other's aliases, but that union is
 * expressed as the plain ordered form below rather than a correlated
 * `array_agg(distinct ...)` subquery, which was valid-looking but unverified on
 * Neon. `distinct` is applied so the stored list is a SET (membership is
 * deterministic for a given set of inputs); the `array(select distinct ...)`
 * ORDER is unspecified by Postgres and is NOT load-bearing here — alias
 * filtering is on membership, not position.
 */
export interface EntityWrite {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
}

/** Upsert entities and return a name -> id map for the given names. */
export async function upsertEntities(
  databaseUrl: string,
  entities: ReadonlyArray<EntityWrite>,
): Promise<ReadonlyMap<string, number>> {
  if (entities.length === 0) return new Map();
  const db = sql(databaseUrl);
  const names = entities.map((e) => e.name);
  // Deterministic: sort + set the aliases in app code before they reach SQL.
  const aliases = entities.map((e) => [...new Set(e.aliases)].sort());

  const rows = await db`
    insert into entities (name, aliases)
    select * from unnest(${names}::text[], ${aliases}::text[][])
    on conflict (name) do update set
      aliases = array(
        select distinct unnest(entities.aliases || excluded.aliases)
      ),
      updated_at = now()
    returning id, name
  `;

  const map = new Map<string, number>();
  for (const row of rows) map.set(String(row.name), Number(row.id));
  return map;
}

/** Link items to canonical entities with the original raw mention for audit. */
export async function linkItemEntities(
  databaseUrl: string,
  links: ReadonlyArray<{ readonly itemId: number; readonly entityId: number; readonly mention: string }>,
): Promise<void> {
  if (links.length === 0) return;
  const db = sql(databaseUrl);
  const itemIds = links.map((l) => l.itemId);
  const entityIds = links.map((l) => l.entityId);
  const mentions = links.map((l) => l.mention);
  await db`
    insert into item_entities (item_id, entity_id, mention)
    select * from unnest(${itemIds}::bigint[], ${entityIds}::bigint[], ${mentions}::text[])
    on conflict (item_id, entity_id) do nothing
  `;
}

// ---------------------------------------------------------------------------
// Clustering persistence (non-destructive).
//
// A cluster is a HINT: we store a cluster row plus membership, and stamp each
// member's `cluster_id`. We never delete or overwrite items. Persistence is
// SET-BASED (a fixed number of statements, independent of hint count) so a busy
// 2000-item window cannot turn into hundreds of sequential Neon HTTP round-trips
// and blow the per-invocation subrequest budget.
//
// Non-destructive also means NON-STICKY: the window slides, so a cluster that
// stops being emitted must release its membership. After writing the current
// hints we (a) stamp only current members, (b) clear `cluster_id` on any item
// whose cluster is no longer live, and (c) mark the stale `clusters` rows
// `inactive_since` (clearing it when a cluster re-forms).
//
// Scoping the clear: we clear by *live cluster id*, not by window membership —
// `cluster_id not in (<current cluster ids>)`. An item is cleared exactly when
// the cluster it points at is no longer corroborated, wherever the item sits
// relative to the window. This is correct for the sliding-window semantics and
// bounded by the (small) number of live clusters, not the window size. A
// residual class remains: items OUTSIDE the window belonging to a cluster that
// is still live stay stamped, which is the intended eventually-consistent hint.
// ---------------------------------------------------------------------------

/** Load candidate rows for clustering from a bounded recent window. */
export async function loadClusterCandidates(
  databaseUrl: string,
  limit: number,
): Promise<ReadonlyArray<ClusterableItem>> {
  const db = sql(databaseUrl);
  const rows = await db`
    select id, source_id, global_title_hash
    from items
    where global_title_hash is not null
    order by id desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    sourceId: String(row.source_id),
    globalTitleHash: (row.global_title_hash as string | null) ?? null,
  }));
}

/**
 * Persist cluster hints and reconcile member `cluster_id`s.
 *
 * Runs a FIXED number of statements regardless of hint count:
 *   1. upsert every cluster row in one `unnest` statement;
 *   2. insert all membership rows in one `unnest` statement;
 *   3. stamp current members in one statement;
 *   4. clear items whose cluster is no longer live in one statement;
 *   5. deactivate/reactivate cluster rows in one statement.
 *
 * `hints` MAY be empty: that is the "window slid, nothing corroborates any more"
 * case, and steps 4–5 still run so stale stamps and rows are released. Returns
 * the number of live clusters written.
 */
export async function saveClusters(
  databaseUrl: string,
  hints: ReadonlyArray<ClusterHint>,
): Promise<number> {
  const db = sql(databaseUrl);

  const keys = hints.map((h) => h.key);
  const anchorIds = hints.map((h) => h.anchorId);
  const sourceIds = hints.map((h) => [...h.sourceIds]);
  const sourceCounts = hints.map((h) => h.sourceIds.length);
  const confidences = hints.map((h) => h.confidence);

  // 1) Upsert all clusters in one round-trip, returning key -> id.
  const clusterIdByKey = new Map<string, number>();
  if (hints.length > 0) {
    const rows = await db`
      insert into clusters (cluster_key, anchor_item_id, source_ids, source_count, confidence, updated_at, inactive_since)
      select k, a, s, c, cf, now(), null
      from unnest(
        ${keys}::text[], ${anchorIds}::bigint[], ${sourceIds}::text[][],
        ${sourceCounts}::int[], ${confidences}::float8[]
      ) as t(k, a, s, c, cf)
      on conflict (cluster_key) do update set
        anchor_item_id = excluded.anchor_item_id,
        source_ids = excluded.source_ids,
        source_count = excluded.source_count,
        confidence = excluded.confidence,
        updated_at = now(),
        inactive_since = null
      returning id, cluster_key
    `;
    for (const row of rows) clusterIdByKey.set(String(row.cluster_key), Number(row.id));
  }

  // 2) Insert all membership rows in one round-trip.
  const memberClusterIds: number[] = [];
  const memberItemIds: number[] = [];
  for (const hint of hints) {
    const clusterId = clusterIdByKey.get(hint.key);
    if (clusterId === undefined) continue;
    for (const memberId of hint.memberIds) {
      memberClusterIds.push(clusterId);
      memberItemIds.push(memberId);
    }
  }
  if (memberItemIds.length > 0) {
    await db`
      insert into cluster_members (cluster_id, item_id)
      select * from unnest(${memberClusterIds}::bigint[], ${memberItemIds}::bigint[])
      on conflict (cluster_id, item_id) do nothing
    `;
  }

  // 3) Stamp current members' cluster_id in one round-trip.
  if (memberItemIds.length > 0) {
    await db`
      update items as i
      set cluster_id = m.cluster_id
      from unnest(${memberItemIds}::bigint[], ${memberClusterIds}::bigint[]) as m(item_id, cluster_id)
      where i.id = m.item_id
    `;
  }

  // 4) Clear stamps on items whose cluster is no longer live. Empty live-id list
  //    means EVERY stamped item is released (the window slid past every echo).
  //
  //    This step is NOT atomic with the concurrent stamp step (3) of another
  //    in-flight message: two messages over overlapping windows can interleave so
  //    a stamp is briefly cleared, or a just-cleared stamp is briefly re-set.
  //    That is ACCEPTED — it is a transient, self-healing condition. Clustering
  //    is an advisory, eventually-consistent hint: the next window recomputes
  //    membership from current corroboration and converges. We do not take a lock
  //    or wrap this in a transaction, because the cost of a momentary stale/absent
  //    hint is far below the cost of serializing every classify message.
  const liveClusterIds = [...clusterIdByKey.values()];
  await db`
    update items
    set cluster_id = null
    where cluster_id is not null
      and cluster_id <> all(${liveClusterIds}::bigint[])
  `;

  // 5) Deactivate clusters that stopped being emitted; reactivate the live ones.
  await db`
    update clusters
    set inactive_since = now()
    where inactive_since is null
      and cluster_key <> all(${keys}::text[])
  `;
  if (keys.length > 0) {
    await db`
      update clusters set inactive_since = null
      where inactive_since is not null and cluster_key = any(${keys}::text[])
    `;
  }

  return hints.length;
}
