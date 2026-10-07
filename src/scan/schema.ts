// ---------------------------------------------------------------------------
// Strict validation of untrusted scanner (LLM) output.
//
// The inference host returns *text*; it is a boundary. Everything is parsed with
// zod before it can touch internal logic, and anything lacking a usable title is
// dropped at parse time (an item with no title is not a signal we can key or
// read). Mirrors the classifier's `parseClassificationResponse` contract: a
// discriminated result rather than a throw, so the caller decides whether to
// retry, log, or simply enqueue what survived.
// ---------------------------------------------------------------------------
import { z } from "zod";

/**
 * One signal as the model reports it. X posts are short and messy, so only the
 * title/text is mandatory; the URL, author, timestamp, and the model's own
 * summary/tags are all optional. Bounds keep a hostile reply from blowing the
 * prompt/queue budget.
 */
export const scannerSignalSchema = z.object({
  /** The post text / headline. Required and non-empty — the drop rule keys on it. */
  title: z.string().trim().min(1).max(1000),
  /** Permalink to the post, when the model can produce one. */
  url: z.string().trim().url().max(2048).optional(),
  /** Author handle or display name. */
  author: z.string().trim().max(200).optional(),
  /** ISO-8601 publication time, when known. */
  publishedAt: z.string().trim().max(64).optional(),
  /** Short model-written synopsis. */
  summary: z.string().trim().max(2000).optional(),
  /** Model-suggested entity/topic tags (raw mentions; canonicalized later). */
  tags: z.array(z.string().trim().min(1).max(120)).max(25).optional(),
});

export type ScannerSignal = z.infer<typeof scannerSignalSchema>;

/**
 * The full scanner reply. Accepts a bare array or `{ signals: [...] }` because
 * JSON-mode providers legitimately wrap arrays in an object.
 */
export const scannerResponseSchema = z.union([
  z.array(scannerSignalSchema),
  z.object({ signals: z.array(scannerSignalSchema) }),
]);

export type ParseSignalsOutcome =
  | { readonly ok: true; readonly signals: ReadonlyArray<ScannerSignal> }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse an untrusted scanner reply into trusted signals.
 *
 * Drops any element that fails the schema (only an element WITH a usable title
 * survives), then reports success. A reply where nothing survives is a valid,
 * empty result — the model simply found no new signals — so `ok` stays true and
 * `signals` is empty. Only structurally unreadable output (not JSON, or not an
 * array/`{signals}` object at all) returns `ok: false`.
 */
export function parseScannerResponse(raw: string): ParseSignalsOutcome {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty response" };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const extracted = extractFirstJsonBlock(text);
    if (extracted === null) return { ok: false, reason: "response was not valid JSON" };
    try {
      json = JSON.parse(extracted);
    } catch {
      return { ok: false, reason: "response was not valid JSON" };
    }
  }

  const envelope = scannerResponseSchema.safeParse(json);
  if (!envelope.success) {
    return { ok: false, reason: envelope.error.issues[0]?.message ?? "schema validation failed" };
  }
  return { ok: true, signals: Array.isArray(envelope.data) ? envelope.data : envelope.data.signals };
}

/** Pull the first balanced `[...]` or `{...}` block out of fenced/annotated text. */
function extractFirstJsonBlock(text: string): string | null {
  const startArray = text.indexOf("[");
  const startObject = text.indexOf("{");
  const starts = [startArray, startObject].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}
