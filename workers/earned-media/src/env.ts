// ---------------------------------------------------------------------------
// Environment bindings and operator-tunable configuration for the earned-media
// drafting agent worker.
//
// This worker is deliberately isolated from the root ingest worker: it pins
// `agents@0.26.0` + `zod@^4`, which are incompatible with the ingest worker's
// `zod@^3`. Env values are strings decided by operators, so they are parsed once
// here into a trusted, typed config (parse, don't validate).
// ---------------------------------------------------------------------------

import type { DraftingAgent } from "./drafting-agent";
import type { EarnedMediaWorkflow } from "./workflow";

/** Durable Object namespace binding for the drafting agent. */
export type DraftingAgentNamespace = DurableObjectNamespace<DraftingAgent>;

/** Workflow binding for the human-in-the-loop earned-media run. */
export type EarnedMediaWorkflowBinding = Workflow<EarnedMediaWorkflowParams>;

/** Environment injected by the Workers runtime. */
export interface Env {
  readonly DRAFTING_AGENT: DraftingAgentNamespace;
  readonly EARNED_MEDIA_WORKFLOW: EarnedMediaWorkflowBinding;

  /** Inference API key. Secret; read only from `env.INCO_API_KEY`, never logged. */
  readonly INCO_API_KEY?: string;
  /** Writer model id. Defaults to `kimi-k3`. */
  readonly INCO_WRITER_MODEL?: string;
  /** `"false"` disables the mandatory AI/brand disclosure line. Default: enabled. */
  readonly DRAFT_DISCLOSURE_ENABLED?: string;
}

/** User params passed to the workflow (agent identity is injected by the SDK). */
export interface EarnedMediaWorkflowParams {
  readonly signal: DetectedSignal;
}

/**
 * A detected discussion the pipeline believes is worth a genuinely useful
 * comment: a Reddit/HN/forum thread about AI-dev-tools or a competitor.
 */
export interface DetectedSignal {
  readonly title: string;
  readonly url: string;
  readonly platform: string;
  readonly snippet: string;
}

/** Exact default writer model id, verified against `GET https://api.inco.ai/v1/models`. */
export const DEFAULT_WRITER_MODEL = "kimi-k3";

/** Trusted drafting-agent runtime config. */
export interface DraftConfig {
  readonly model: string;
  readonly disclosureEnabled: boolean;
}

/** `"false"` (case-insensitive) disables; anything else (or absent) enables. */
function enabledFlag(value: string | undefined): boolean {
  return (value ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Build the draft config from env. Pure and deterministic.
 *
 * Disclosure is DEFAULT ON: only the literal `"false"` turns it off, so an
 * operator must opt out explicitly rather than forget to opt in.
 */
export function getDraftConfig(env: Pick<Env, "INCO_WRITER_MODEL" | "DRAFT_DISCLOSURE_ENABLED">): DraftConfig {
  return {
    model: env.INCO_WRITER_MODEL?.trim() || DEFAULT_WRITER_MODEL,
    disclosureEnabled: enabledFlag(env.DRAFT_DISCLOSURE_ENABLED),
  };
}
