import { handleQueue, pollSource } from "./consumer";
import { runPoller, selectDueSources } from "./poller";
import { findSource, getSources } from "./registry";
import { loadSourceStates, syncSources } from "./db";
import { SCANNER_CRON } from "./scan/config";
import { runScanner } from "./scan/grok-x";
import { MAX_MESSAGE_BYTES, chunkSignals, messageBytes } from "./queue";
import type { Env, QueueMessage, RawSignal } from "./types";

export default {
  /**
   * Cron trigger: enqueue only. The Worker has ONE `scheduled` handler for every
   * declared cron, so it dispatches on `event.cron`:
   *   - the frequent poller tick enqueues due sources;
   *   - the four-hourly scanner tick runs the Grok X scan.
   * Both are "enqueue/write small" paths; heavy work lives in the consumers.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === SCANNER_CRON) {
      ctx.waitUntil(runScanner(env));
      return;
    }
    ctx.waitUntil(runPoller(env));
  },

  /** Queue consumer: fetch + normalize + dedup + write. */
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },

  /**
   * HTTP surface. Kept intentionally small:
   *   GET  /health                     -> liveness
   *   GET  /sources                    -> expanded registry (read-only)
   *   POST /trigger/:sourceId          -> manually poll one source (auth required)
   *   POST /signals/:sourceId          -> seam for the deferred Grok/X scanner
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/sources") {
      const sources = getSources();
      return json({ count: sources.length, sources });
    }

    const triggerMatch = url.pathname.match(/^\/trigger\/([^/]+)$/);
    if (triggerMatch && request.method === "POST") {
      return manualTrigger(env, decodeURIComponent(triggerMatch[1] as string), request);
    }

    const signalMatch = url.pathname.match(/^\/signals\/([^/]+)$/);
    if (signalMatch && request.method === "POST") {
      return manualSignals(env, decodeURIComponent(signalMatch[1] as string), request);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env, QueueMessage>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.MANUAL_TRIGGER_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

/** Manually poll a single source — the testing path described in the README. */
async function manualTrigger(env: Env, sourceId: string, request: Request): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  const source = findSource(sourceId);
  if (!source) {
    return json({ error: `unknown source "${sourceId}"` }, 404);
  }
  try {
    const outcome = await pollSource(env, source);
    return json({ sourceId, ...outcome });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return json({ sourceId, status: "error", error: detail }, 502);
  }
}

/** Max signals accepted in a single POST. Bounds work and payload size. */
const MAX_SIGNALS_PER_REQUEST = 50;

/**
 * Parse one untrusted payload element into a trusted `RawSignal`, or reject it.
 * Parse, don't validate: a signal missing a non-empty `title` or `url` is not a
 * usable item, so it is dropped here rather than reaching the queue.
 */
function parseSignal(raw: unknown): RawSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record["title"] === "string" ? record["title"].trim() : "";
  const url = typeof record["url"] === "string" ? record["url"].trim() : "";
  if (title === "" || url === "") return null;
  const author = typeof record["author"] === "string" ? record["author"] : undefined;
  const publishedAt = typeof record["publishedAt"] === "string" ? record["publishedAt"] : undefined;
  const summary = typeof record["summary"] === "string" ? record["summary"] : undefined;
  const rawContent = typeof record["rawContent"] === "string" ? record["rawContent"] : undefined;
  const signalTags = Array.isArray(record["signalTags"])
    ? record["signalTags"].filter((t): t is string => typeof t === "string")
    : undefined;
  return {
    title,
    url,
    ...(author !== undefined ? { author } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(rawContent !== undefined ? { rawContent } : {}),
    ...(signalTags !== undefined ? { signalTags } : {}),
  };
}

/**
 * Clean seam for the deferred Grok/X scanner: POST an array of signals that are
 * normalized with the same pipeline and written to `items`. Enqueued (not inline)
 * so the fast HTTP path stays fast and retries ride the same queue.
 *
 * The source MUST already exist in the registry (seed it first): signals to an
 * unknown source are rejected, matching the consumer's fail-loud behavior.
 */
async function manualSignals(env: Env, sourceId: string, request: Request): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  const source = findSource(sourceId);
  if (!source) {
    return json({ error: `unknown source "${sourceId}"` }, 404);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const rawItems = Array.isArray(payload) ? payload : (payload as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) {
    return json({ error: "expected a JSON array or { items: [...] }" }, 400);
  }
  if (rawItems.length > MAX_SIGNALS_PER_REQUEST) {
    return json(
      { error: `too many signals: ${rawItems.length} exceeds ${MAX_SIGNALS_PER_REQUEST}` },
      413,
    );
  }

  // Parse each element at the boundary; drop the unusable ones and count them.
  const accepted = rawItems.map(parseSignal).filter((s): s is RawSignal => s !== null);
  const rejected = rawItems.length - accepted.length;
  if (accepted.length === 0) {
    return json({ sourceId, accepted: 0, rejected, enqueued: 0 }, 400);
  }

  const enqueuedAt = new Date().toISOString();
  const { messages, droppedOversized } = chunkSignals(sourceId, enqueuedAt, accepted);
  for (const message of messages) {
    await env.INGEST_QUEUE.send(message);
  }
  const totalRejected = rejected + droppedOversized;
  if (totalRejected > 0) {
    console.error(
      JSON.stringify({ event: "signals.rejected", sourceId, rejected, droppedOversized }),
    );
  }
  return json(
    {
      sourceId,
      accepted: accepted.length - droppedOversized,
      rejected: totalRejected,
      enqueued: messages.length,
    },
    202,
  );
}

// Re-exported for scripts/tests and to keep the module graph explicit.
export { runPoller, selectDueSources, syncSources, loadSourceStates };
export { chunkSignals, messageBytes, MAX_MESSAGE_BYTES, signalMessage } from "./queue";
// Signal-layer pure logic, re-exported for `scripts/smoke.ts` (no network/DB).
export { parseClassificationResponse, SIGNAL_LABELS } from "./classify/schema";
export { chunkItems, reconcile, missingIndices, isValidRepairIndexSet, unclassified } from "./classify/batch";
export {
  buildClassificationPrompt,
  buildRepairPrompt,
  CLASSIFIER_PROMPT_VERSION,
} from "./classify/prompt";
export { getClassifierConfig, DEFAULT_CLASSIFIER_MODEL, DEFAULT_WRITER_MODEL } from "./classify/config";
export { shouldWriteClassification, shouldLoadForClassification } from "./classify/write-policy";
export { classifyOneBatch } from "./classify/handler";
export { canonicalizeEntity, canonicalizeEntities, normalizeMention } from "./entities/aliases";
export { clusterByGlobalTitleHash, currentClusterMemberIds, clusterLifecycle } from "./entities/cluster";
// Grok X-scanner pure logic, re-exported for `scripts/smoke.ts` (no network/DB).
export {
  getScannerConfig,
  DEFAULT_SCANNER_MODEL,
  DEFAULT_TRACKED_ENTITIES,
  SCANNER_CRON,
  SCANNER_SOURCE_ID,
} from "./scan/config";
export { parseScannerResponse } from "./scan/schema";
export { mapScannerSignal, scannerDedupKey, selectNewSignals } from "./scan/map";
export { buildScannerPrompt, SCANNER_PROMPT_VERSION } from "./scan/prompt";
export { runScanner } from "./scan/grok-x";
