// ---------------------------------------------------------------------------
// Grok-driven X scanner.
//
// Every four hours (see `SCANNER_CRON`) this asks an X-data-savvy model, via the
// SAME OpenAI-compatible client the classifier uses (`src/inco/client.ts`), for
// NEW signals about tracked AI developer tools. The untrusted reply is validated
// with zod (`src/scan/schema.ts`), mapped to the ingest `RawSignal` shape
// (`src/scan/map.ts`), and ENQUEUED as `ingest-signal` messages on the existing
// ingest queue. From there the normal consumer path normalizes, dedups, writes
// to `items`, and (via the decoupled classify queue) classifies them. There is
// NO parallel database path here.
//
// Guards (all fail CLOSED, i.e. skip rather than spend):
//   1. `SCANNER_ENABLED` must be "true" (default false).
//   2. `INCO_API_KEY` must be set.
//   3. The scanner model must be configured (not the placeholder).
//   4. The scanner source must exist in the registry, or the consumer would
//      reject the enqueued message; we check up front and skip loudly.
//
// Idempotency/cost: signals are de-duped against a bounded rolling set of stable
// keys persisted in the `meta` table, on top of the DB's `(source_id,
// canonical_url)`/`(source_id, title_hash)` dedup. The per-scan cap bounds spend.
// ---------------------------------------------------------------------------
import { createIncoClient, IncoError, type ChatResult, type IncoClient } from "../inco/client";
import { findSource } from "../registry";
import { loadScannerSeenKeys, saveScannerSeenKeys } from "../db";
import { chunkSignals } from "../queue";
import { getScannerConfig, SCANNER_SOURCE_ID, type ScannerConfig } from "./config";
import { buildScannerPrompt, SCANNER_PROMPT_VERSION } from "./prompt";
import { parseScannerResponse } from "./schema";
import { selectNewSignals, type MappedSignal } from "./map";
import type { Env, QueueMessage } from "../types";

/** Provider request settings the scanner pins (deterministic, non-creative). */
const SCANNER_TEMPERATURE = 0;

/**
 * How many stable keys the rolling seen-set remembers. Small on purpose: it only
 * needs to cover the gap between adjacent four-hourly scans, and the database
 * remains the authoritative dedup. ~4x the per-scan cap leaves headroom.
 */
const SEEN_KEY_WINDOW = 400;

export interface ScanOutcome {
  readonly status: "scanned" | "skipped-disabled" | "skipped-unconfigured" | "empty" | "error";
  /** Signals the model returned and the schema accepted. */
  readonly scanned: number;
  /** Signals actually enqueued (after dedup + cap + size guard). */
  readonly enqueued: number;
  /** Signals dropped: schema-rejected, duplicate, over-cap, or oversized. */
  readonly rejected: number;
  /** LLM calls made (1 on a real scan). */
  readonly llmCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Injection seam for tests: mock the LLM client and the DB read/write/enqueue.
 * In production every dependency defaults to the real implementation.
 */
export interface ScanDeps {
  readonly makeClient?: (env: Env, model: string) => IncoClient;
  readonly loadSeen?: (env: Env) => Promise<ReadonlySet<string>>;
  readonly saveSeen?: (env: Env, keys: ReadonlyArray<string>) => Promise<void>;
  readonly enqueue?: (env: Env, messages: ReadonlyArray<QueueMessage>) => Promise<void>;
}

function emptyOutcome(status: ScanOutcome["status"]): ScanOutcome {
  return {
    status,
    scanned: 0,
    enqueued: 0,
    rejected: 0,
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

/**
 * Run one scan. Never throws: every failure is logged and reported as
 * `status: "error"` so a cron tick cannot leave an unhandled rejection. The
 * queue consumer (not this scan) owns retry/backoff for what is enqueued.
 */
export async function runScanner(env: Env, deps: ScanDeps = {}): Promise<ScanOutcome> {
  const config = getScannerConfig(env);
  const startedAt = Date.now();

  // Guard 1/2/3: kill switch, key, and a real model id. Any missing piece is a
  // configuration choice, not an error — log once and skip without spending.
  const apiKey = env.INCO_API_KEY?.trim();
  if (!config.enabled || !apiKey || apiKey === "") {
    const reason = !config.enabled ? "disabled" : "no-api-key";
    return logAndReturn(emptyOutcome("skipped-disabled"), { reason, durationMs: Date.now() - startedAt });
  }
  if (!config.modelConfigured) {
    return logAndReturn(emptyOutcome("skipped-unconfigured"), {
      reason: "scanner-model-placeholder",
      durationMs: Date.now() - startedAt,
    });
  }

  // Guard 4: the source must be registered, or the consumer rejects the signal.
  if (!findSource(SCANNER_SOURCE_ID)) {
    console.error(
      JSON.stringify({
        event: "scan.source_missing",
        sourceId: SCANNER_SOURCE_ID,
        detail: "scanner source is not in the registry; refusing to enqueue signals that would be rejected",
      }),
    );
    return emptyOutcome("error");
  }

  const client = deps.makeClient?.(env, config.model) ?? createIncoClient({ apiKey });
  const loadSeen = deps.loadSeen ?? ((e: Env) => loadScannerSeenKeys(e.DATABASE_URL));
  const saveSeen = deps.saveSeen ?? ((e: Env, keys) => saveScannerSeenKeys(e.DATABASE_URL, keys));
  const enqueue =
    deps.enqueue ??
    (async (e: Env, messages) => {
      for (const message of messages) await e.INGEST_QUEUE.send(message);
    });

  try {
    const prompt = buildScannerPrompt(config);
    const result = await client.chat({
      model: config.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: SCANNER_TEMPERATURE,
      responseFormat: "json",
    });

    const usage = usageOf(result);
    const parsed = parseScannerResponse(result.content);
    if (!parsed.ok) {
      // Untrusted output that will not parse is a scan failure, not a signal.
      console.error(
        JSON.stringify({ event: "scan.parse_failed", reason: parsed.reason, model: result.model }),
      );
      return logAndReturn(
        { ...emptyOutcome("error"), llmCalls: 1, ...usage },
        { durationMs: Date.now() - startedAt },
      );
    }

    const seen = await loadSeen(env);
    const { mapped, skipped } = selectNewSignals(parsed.signals, seen, config.maxItemsPerScan);
    if (mapped.length === 0) {
      const outcome: ScanOutcome = {
        ...emptyOutcome("empty"),
        scanned: parsed.signals.length,
        rejected: parsed.signals.length - mapped.length,
        llmCalls: 1,
        ...usage,
      };
      return logAndReturn(outcome, { durationMs: Date.now() - startedAt });
    }

    const enqueuedAt = new Date().toISOString();
    const { messages, droppedOversized } = chunkSignals(
      SCANNER_SOURCE_ID,
      enqueuedAt,
      mapped.map((m) => m.signal),
    );
    await enqueue(env, messages);

    // Persist the rolling window: keep the keys we just enqueued (the ones that
    // actually fit a message) plus a tail of the prior set, bounded to
    // SEEN_KEY_WINDOW. Best-effort — a lost window only costs a redundant enqueue.
    const keptKeys = mapped.slice(0, mapped.length - droppedOversized).map((m) => m.dedupKey);
    await saveSeen(env, nextSeenKeys(seen, keptKeys)).catch((saveError: unknown) => {
      console.error(JSON.stringify({ event: "scan.seen_keys.save_failed", error: String(saveError) }));
    });

    const outcome: ScanOutcome = {
      status: "scanned",
      scanned: parsed.signals.length,
      enqueued: mapped.length - droppedOversized,
      rejected: parsed.signals.length - mapped.length + droppedOversized,
      llmCalls: 1,
      ...usage,
    };
    return logAndReturn(outcome, { durationMs: Date.now() - startedAt, deduped: skipped });
  } catch (error: unknown) {
    // Network/http faults from the client are logged and reported, never thrown:
    // the cron tick must not fail. A transient fault simply waits for the next
    // four-hourly tick.
    const detail = error instanceof Error ? error.message : String(error);
    const kind = error instanceof IncoError ? error.kind : "unknown";
    console.error(
      JSON.stringify({ event: "scan.failed", kind, retryable: error instanceof IncoError ? error.retryable : null, error: detail }),
    );
    return emptyOutcome("error");
  }
}

/** Compute the next bounded rolling seen-set: current keys first, prior tail after. */
function nextSeenKeys(
  previous: ReadonlySet<string>,
  justKept: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const key of [...justKept, ...previous]) {
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
    if (merged.length >= SEEN_KEY_WINDOW) break;
  }
  return merged;
}

function usageOf(result: ChatResult): { readonly promptTokens: number; readonly completionTokens: number } {
  return {
    promptTokens: result.usage?.promptTokens ?? 0,
    completionTokens: result.usage?.completionTokens ?? 0,
  };
}

/** Emit the structured audit line and return the outcome unchanged. */
function logAndReturn(
  outcome: ScanOutcome,
  extra: Record<string, unknown>,
): ScanOutcome {
  console.log(
    JSON.stringify({
      event: "scan.complete",
      promptVersion: SCANNER_PROMPT_VERSION,
      status: outcome.status,
      scanned: outcome.scanned,
      enqueued: outcome.enqueued,
      rejected: outcome.rejected,
      llmCalls: outcome.llmCalls,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      ...extra,
    }),
  );
  return outcome;
}

/** Re-exported so callers/tests can reference the mapped shape without a deep import. */
export type { MappedSignal };
