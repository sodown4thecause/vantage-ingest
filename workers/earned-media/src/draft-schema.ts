// ---------------------------------------------------------------------------
// Strict validation of untrusted LLM output for an earned-media draft.
//
// The inference host returns *text*; it is a boundary, so everything is parsed
// with zod before it can touch internal logic. A draft must also carry the
// mandatory AI/brand disclosure line (unless an operator has explicitly disabled
// it) — that invariant is enforced here, at the boundary, so no downstream code
// can ever persist an undisclosed draft.
// ---------------------------------------------------------------------------
import { z } from "zod";

/** Closed set of platforms a draft can target. Unknown values fail at parse. */
export const DRAFT_PLATFORMS = ["reddit", "hackernews", "forum", "other"] as const;

export type DraftPlatform = (typeof DRAFT_PLATFORMS)[number];

/** A draft the model claimed to produce. `disclosureLine` may be absent. */
export const rawDraftSchema = z.object({
  /** Proposed comment body. Bounded so a runaway reply cannot blow up storage. */
  body: z.string().trim().min(1).max(4_000),
  /** Optional note the model gives the human reviewer (why this is useful). */
  rationale: z.string().trim().max(1_000).default(""),
  /** The disclosure line the model included, if any. Enforced below. */
  disclosureLine: z.string().trim().max(300).optional(),
});

export type RawDraft = z.infer<typeof rawDraftSchema>;

/** A validated draft ready for the review queue. */
export interface EarnedMediaDraft {
  readonly body: string;
  readonly rationale: string;
  readonly disclosureLine: string;
}

/** The canonical disclosure line appended when the model omits one. */
export const DEFAULT_DISCLOSURE_LINE =
  "Disclosure: I use AI-assisted drafting and I'm affiliated with the team behind this tool.";

/** Discriminated parse outcome — callers decide how to react; never throws. */
export type DraftParseOutcome =
  | { readonly ok: true; readonly draft: EarnedMediaDraft }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse an untrusted model reply into a trusted draft.
 *
 * When `disclosureEnabled` is true, a missing disclosure line is filled with the
 * canonical {@link DEFAULT_DISCLOSURE_LINE} rather than rejected: the guarantee
 * is that a persisted draft ALWAYS carries a disclosure, and a helpful body is
 * not thrown away just because the model forgot one line.
 */
export function parseDraftResponse(raw: string, disclosureEnabled: boolean): DraftParseOutcome {
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

  const parsed = rawDraftSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "schema validation failed" };
  }

  const disclosureLine = resolveDisclosureLine(parsed.data.disclosureLine, disclosureEnabled);
  return {
    ok: true,
    draft: {
      body: parsed.data.body,
      rationale: parsed.data.rationale,
      disclosureLine,
    },
  };
}

/**
 * Resolve the disclosure line the draft must carry. Pure and total.
 *
 * - Disclosure disabled by the operator => empty string (explicit opt-out).
 * - Model supplied a line => use it verbatim.
 * - Model omitted one => fall back to the canonical line.
 */
export function resolveDisclosureLine(modelLine: string | undefined, enabled: boolean): string {
  if (!enabled) return "";
  if (modelLine !== undefined && modelLine.trim() !== "") return modelLine.trim();
  return DEFAULT_DISCLOSURE_LINE;
}

/** Assemble the final reviewable text: body plus a disclosure line, when enabled. */
export function composeDraftText(draft: EarnedMediaDraft): string {
  if (draft.disclosureLine === "") return draft.body;
  return `${draft.body}\n\n${draft.disclosureLine}`;
}

/** Pull the first balanced `{...}` block out of fenced/annotated text. */
function extractFirstJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = text.lastIndexOf("}");
  if (end <= start) return null;
  return text.slice(start, end + 1);
}
