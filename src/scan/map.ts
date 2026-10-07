// ---------------------------------------------------------------------------
// Pure mapping: validated scanner signals -> ingest `RawSignal`s, with a stable
// per-signal dedup key and a per-scan cap. No I/O, no env, no network.
//
// The scanner runs every four hours and the pipeline already dedups on
// `(source_id, canonical_url)` and `(source_id, title_hash)` in the database.
// This module adds the CHEAPER, earlier guard: a stable key derived from the
// signal itself, so an identical item surfaced twice in a short window is not
// re-enqueued (and does not spend queue work or a classify call). The DB
// constraints remain the authoritative backstop.
// ---------------------------------------------------------------------------
import type { RawSignal } from "../types";
import { canonicalizeUrl, normalizeTitle } from "../normalizer";
import { normalizeMention } from "../entities/aliases";
import type { ScannerSignal } from "./schema";

export interface MappedSignal {
  /** The ingest-shaped signal, ready for an `ingest-signal` message. */
  readonly signal: RawSignal;
  /**
   * Stable identity for this signal within the scanner source. Derived from the
   * canonical URL when present (mirrors the DB's primary dedup key), otherwise
   * from the normalized title. Same input always maps to the same key.
   */
  readonly dedupKey: string;
}

/**
 * A stable, host-independent key for one scanned signal.
 *
 * Preference order mirrors the DB dedup: a canonical URL is the strongest
 * identity, so it is used when present; a URL-less post (rare on X) falls back
 * to its normalized title. The scanner source id is NOT mixed in — the scanner
 * only ever writes to one source, and a bare key is easier to audit.
 */
export function scannerDedupKey(signal: ScannerSignal): string {
  const url = signal.url?.trim();
  if (url !== undefined && url !== "") {
    return `url:${canonicalizeUrl(url)}`;
  }
  return `title:${normalizeTitle(signal.title)}`;
}

/**
 * Map one validated scanner signal onto the ingest `RawSignal` shape.
 *
 * `summary` and `rawContent` prefer the model's synopsis, falling back to the
 * title (a post with no summary still yields usable content). `signalTags` are
 * the model's raw tags, normalized for de-dup and empties dropped. `publishedAt`
 * is passed through as-is: the normalizer coerces it to a trusted timestamp (or
 * null), so an unparseable date cannot reach the DB as a bad value.
 */
export function mapScannerSignal(signal: ScannerSignal): MappedSignal {
  const summary = signal.summary?.trim() ?? "";
  const url = signal.url?.trim() ?? "";
  const tags = dedupeTags(signal.tags ?? []);
  const raw: RawSignal = {
    title: signal.title,
    url,
    ...(signal.author !== undefined ? { author: signal.author } : {}),
    ...(signal.publishedAt !== undefined ? { publishedAt: signal.publishedAt } : {}),
    ...(summary !== "" ? { summary } : {}),
    rawContent: summary !== "" ? summary : signal.title,
    ...(tags.length > 0 ? { signalTags: tags } : {}),
  };
  return { signal: raw, dedupKey: scannerDedupKey(signal) };
}

/**
 * Map, de-dup, and cap a batch of validated signals.
 *
 * Order of operations is deliberate:
 *   1. map every signal (pure);
 *   2. drop ones whose key was already seen IN THIS BATCH or in `seenKeys`
 *      (the recent-window set the caller loaded);
 *   3. cap the survivors at `maxItems`.
 *
 * `seenKeys` is treated as read-only; the function reports the keys it decided to
 * KEEP so the caller can persist them for the next scan. Pure: same inputs in,
 * same outputs out.
 */
export function selectNewSignals(
  signals: ReadonlyArray<ScannerSignal>,
  seenKeys: ReadonlySet<string>,
  maxItems: number,
): { readonly mapped: ReadonlyArray<MappedSignal>; readonly skipped: number } {
  const mapped: MappedSignal[] = [];
  const keysThisBatch = new Set<string>();
  let skipped = 0;
  for (const signal of signals) {
    const candidate = mapScannerSignal(signal);
    const isDuplicate = keysThisBatch.has(candidate.dedupKey) || seenKeys.has(candidate.dedupKey);
    if (isDuplicate) {
      skipped += 1;
      continue;
    }
    if (mapped.length >= Math.max(0, maxItems)) {
      skipped += 1;
      continue;
    }
    keysThisBatch.add(candidate.dedupKey);
    mapped.push(candidate);
  }
  return { mapped, skipped };
}

/** Stable de-dup of tags (case-insensitive on the normalized mention), trimmed. */
function dedupeTags(tags: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const key = normalizeMention(trimmed);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
