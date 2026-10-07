// ---------------------------------------------------------------------------
// Grok X-scanner configuration, parsed from env at the boundary.
//
// Why a module: env values are strings decided by operators. Parsing them once
// into a trusted, typed config keeps defaults, clamps, the kill switch, and the
// tracked-entity list in one auditable place. Illegal states (a negative cap, an
// empty entity list) are corrected to safe defaults rather than crashing cron.
//
// The scanner is OFF by default (`SCANNER_ENABLED` defaults to "false") because
// it needs a real model id and an inference key before it can do anything
// useful. Turning it on is a deliberate operator decision.
// ---------------------------------------------------------------------------
import type { Env } from "../types";

/**
 * Placeholder scanner model id. The provider is OpenAI-compatible and
 * model-agnostic (see `src/inco/client.ts`); the *X-scanning* model is chosen by
 * the operator via `INCO_SCANNER_MODEL`. This placeholder is intentionally
 * obvious so an unset model never silently spends money on the wrong capability:
 * the scanner refuses to run while the model equals this value.
 */
export const DEFAULT_SCANNER_MODEL = "replace-with-grok-x-scanner-model";

/**
 * The extra cron expression the scanner rides on. "every 4 hours" (the standard
 * 5-field cron form). Declared in `wrangler.toml`; this constant is the app-side
 * check that the firing cron IS the scanner cron (the Worker has one `scheduled`
 * handler for all triggers, see `src/index.ts`).
 */
export const SCANNER_CRON = "0 */4 * * *";

/**
 * The registry id of the scanner's pseudo-source. Signals enqueued by the
 * scanner are attributed to this source, so it MUST exist in the expanded
 * registry (seeded in `src/registry/seed.ts`) or the consumer rejects them.
 */
export const SCANNER_SOURCE_ID = "grok-x-scanner";

/**
 * Default tracked entities: competitors, adjacent tools, and the user's own
 * product. Kept as a small, editable literal so "watch a new competitor" is a
 * config edit. The keyword list is advisory context for the model, not a strict
 * filter (the model sees these strings in the prompt).
 */
export const DEFAULT_TRACKED_ENTITIES: ReadonlyArray<string> = [
  "Cursor",
  "GitHub Copilot",
  "Claude Code",
  "OpenAI Codex",
  "Windsurf",
  "Cline",
  "Aider",
  "Devin",
  "Replit",
  "Google Gemini",
  "LangChain",
];

/** Named scanner keywords (themes) the model should watch for, alongside entities. */
export const DEFAULT_TRACKED_KEYWORDS: ReadonlyArray<string> = [
  "AI coding agent",
  "AI code review",
  "developer tool launch",
  "funding round",
  "new model release",
];

export const DEFAULT_MAX_ITEMS_PER_SCAN = 25;

/** Trusted scanner runtime config. */
export interface ScannerConfig {
  /** Master kill switch. Off unless the operator sets `SCANNER_ENABLED="true"`. */
  readonly enabled: boolean;
  /** Scanner model id. Never equal to {@link DEFAULT_SCANNER_MODEL} when enabled. */
  readonly model: string;
  /** Whether a real (non-placeholder) model id has been configured. */
  readonly modelConfigured: boolean;
  /** Competitor/product names to track. */
  readonly trackedEntities: ReadonlyArray<string>;
  /** Theme keywords to track alongside the entities. */
  readonly trackedKeywords: ReadonlyArray<string>;
  /** Hard cap on signals enqueued per scan (cost/queue guardrail). */
  readonly maxItemsPerScan: number;
}

/** Parse a positive integer env var, or return the fallback on garbage/absence. */
function positiveIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `"true"` (case-insensitive) enables; anything else (or absent) disables. */
function enabledFlag(value: string | undefined): boolean {
  return (value ?? "false").trim().toLowerCase() === "true";
}

/**
 * Parse a comma-separated list, trimming and dropping empties. Returns the
 * fallback when the input is absent or yields nothing usable, so the scanner
 * always has at least one entity/keyword to look for.
 */
function csvOr(value: string | undefined, fallback: ReadonlyArray<string>): ReadonlyArray<string> {
  if (value === undefined) return fallback;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Build the scanner config from env. Pure and deterministic.
 *
 * `modelConfigured` is false while the model is absent or still the placeholder;
 * callers use it (together with `enabled`) to skip a scan without spending a
 * request against the wrong capability.
 */
export function getScannerConfig(env: Env): ScannerConfig {
  const model = env.INCO_SCANNER_MODEL?.trim() || DEFAULT_SCANNER_MODEL;
  return {
    enabled: enabledFlag(env.SCANNER_ENABLED),
    model,
    modelConfigured: model !== DEFAULT_SCANNER_MODEL,
    trackedEntities: csvOr(env.SCANNER_TRACKED_ENTITIES, DEFAULT_TRACKED_ENTITIES),
    trackedKeywords: csvOr(env.SCANNER_TRACKED_KEYWORDS, DEFAULT_TRACKED_KEYWORDS),
    maxItemsPerScan: positiveIntOr(env.SCANNER_MAX_ITEMS_PER_SCAN, DEFAULT_MAX_ITEMS_PER_SCAN),
  };
}
