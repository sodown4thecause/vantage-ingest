// ---------------------------------------------------------------------------
// Scanner prompt construction (pure). No I/O, no db, no env.
//
// The tracked-entities/keywords list is injected here, so "watch a new
// competitor" stays a config edit. The output contract is stated in the system
// prompt and enforced by `src/scan/schema.ts`; the prompt text and the schema
// must agree (an id the schema drops is wasted work, an id not requested is a
// hallucination risk).
// ---------------------------------------------------------------------------
import type { ScannerConfig } from "./config";

export interface ScannerPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * Bump when the prompt text or output contract changes. Exported so logs can
 * carry it alongside scan results (the scanner does not store a version, since
 * it writes nothing directly — the items it enqueues inherit the classifier's
 * version on the classify path).
 */
export const SCANNER_PROMPT_VERSION = "v1";

const SYSTEM_PROMPT = [
  "You are a research assistant scanning X (Twitter) for NEW go-to-market signals",
  "about AI developer tools: competitor moves, product launches, funding, notable",
  "releases, complaints, and shifts in developer sentiment.",
  "",
  "Return STRICT JSON only. No prose, no markdown fences.",
  'Shape: {"signals":[{"title":"<post text or headline>","url":"<permalink, if known>",',
  '"author":"<handle, if known>","publishedAt":"<ISO-8601, if known>",',
  '"summary":"<one short sentence>","tags":["<entity or topic>"]}]}',
  "",
  "Rules:",
  "- Report ONLY signals that appear NEW (recent posts), not background or evergreen content.",
  "- `title` is required and must be non-empty. Omit any signal you cannot title.",
  "- `url` is optional: include the X permalink when you are confident of it, otherwise omit.",
  "- Copy `tags` from real tool/company/topic mentions in the post; do not invent.",
  "- Do not fabricate posts, URLs, authors, or dates. An empty array is a valid answer.",
].join("\n");

/** Build the user turn: the tracked entities/keywords and the JSON reminder. */
function buildUserPrompt(config: ScannerConfig): string {
  return [
    "Track signals involving ANY of these entities / products:",
    config.trackedEntities.map((entity) => `- ${entity}`).join("\n"),
    "",
    "And these themes:",
    config.trackedKeywords.map((keyword) => `- ${keyword}`).join("\n"),
    "",
    `Return at most ${config.maxItemsPerScan} of the strongest NEW signals as JSON.`,
  ].join("\n");
}

/** Pure: same config in, same prompt out. */
export function buildScannerPrompt(config: ScannerConfig): ScannerPrompt {
  return { system: SYSTEM_PROMPT, user: buildUserPrompt(config) };
}
