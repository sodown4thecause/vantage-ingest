// ---------------------------------------------------------------------------
// Pure review-queue state transitions and the audit-record shape.
//
// These functions are deliberately free of Durable Object / network / SQL
// concerns so the human-in-the-loop invariants can be tested hermetically.
// `DraftingAgent` delegates to them; the DO only owns persistence and RPC.
//
// Core invariant: a draft leaves the `pending` queue ONLY through an explicit
// human decision (approve/reject). There is no automatic transition.
// ---------------------------------------------------------------------------
import type { EarnedMediaDraft } from "./draft-schema";

/** A draft awaiting human review, as held in agent state. */
export interface PendingDraft {
  readonly workflowId: string;
  readonly signalTitle: string;
  readonly signalUrl: string;
  readonly platform: string;
  /** The validated draft text a human will review (already disclosed). */
  readonly body: string;
  readonly rationale: string;
  readonly disclosureLine: string;
  /** Unix ms when the draft entered the queue. */
  readonly createdAt: number;
}

/** Immutable record of a human decision, mirrored into the DO's `sql` audit table. */
export interface AuditRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly decision: "approved" | "rejected";
  readonly decidedBy: string;
  readonly decidedAt: number;
  readonly reason: string;
}

/** The pending-drafts review queue. Pure data; no side effects. */
export interface ReviewQueueState {
  readonly pendingDrafts: ReadonlyArray<PendingDraft>;
  readonly drafts: ReadonlyArray<PendingDraft>;
}

/** Initial state: an empty review queue. */
export const INITIAL_REVIEW_QUEUE: ReviewQueueState = {
  pendingDrafts: [],
  drafts: [],
};

/** Inputs needed to enqueue a freshly drafted comment. */
export interface DraftForReviewInput {
  readonly workflowId: string;
  readonly signal: { readonly title: string; readonly url: string; readonly platform: string };
  readonly draft: EarnedMediaDraft;
  readonly now: number;
}

/** Build a {@link PendingDraft} from a validated draft. Pure and total. */
export function toPendingDraft(input: DraftForReviewInput): PendingDraft {
  return {
    workflowId: input.workflowId,
    signalTitle: input.signal.title,
    signalUrl: input.signal.url,
    platform: input.signal.platform,
    body: input.draft.body,
    rationale: input.draft.rationale,
    disclosureLine: input.draft.disclosureLine,
    createdAt: input.now,
  };
}

/**
 * Enqueue a draft into pending review, replacing any prior entry for the same
 * workflow (idempotent under workflow retries — a re-delivered "surface to
 * review" step must not duplicate a queue entry).
 */
export function enqueueDraft(
  state: ReviewQueueState,
  draft: PendingDraft,
): ReviewQueueState {
  const withoutStale = state.pendingDrafts.filter((p) => p.workflowId !== draft.workflowId);
  return {
    pendingDrafts: [...withoutStale, draft],
    drafts: withoutStale.length === state.pendingDrafts.length ? state.drafts : state.drafts.filter((d) => d.workflowId !== draft.workflowId),
  };
}

/** Why an approval may be refused. A discriminated result keeps callers honest. */
export type DecisionError = "not_found";

export type DecisionOutcome =
  | { readonly ok: true; readonly state: ReviewQueueState; readonly record: AuditRecord }
  | { readonly ok: false; readonly error: DecisionError };

/** Inputs for a human approval decision. */
export interface ApproveInput {
  readonly workflowId: string;
  readonly approvedBy: string;
  /** Optional human edit of the draft body; when present it replaces the draft text. */
  readonly editedText?: string;
  readonly reason?: string;
  readonly now: number;
  readonly auditId: string;
}

/**
 * Apply a human approval. Removes exactly one pending draft and produces the
 * audit record. Returns `not_found` when the workflow is not pending — a
 * decision can never be applied twice or to an unknown workflow.
 */
export function approveDraftFromQueue(state: ReviewQueueState, input: ApproveInput): DecisionOutcome {
  const target = state.pendingDrafts.find((p) => p.workflowId === input.workflowId);
  if (target === undefined) return { ok: false, error: "not_found" };

  const approved: PendingDraft =
    input.editedText !== undefined && input.editedText.trim() !== ""
      ? { ...target, body: input.editedText.trim() }
      : target;

  return {
    ok: true,
    state: {
      pendingDrafts: state.pendingDrafts.filter((p) => p.workflowId !== input.workflowId),
      drafts: replaceById(state.drafts, approved),
    },
    record: {
      id: input.auditId,
      workflowId: input.workflowId,
      decision: "approved",
      decidedBy: input.approvedBy,
      decidedAt: input.now,
      reason: input.reason ?? "",
    },
  };
}

/** Inputs for a human rejection decision. */
export interface RejectInput {
  readonly workflowId: string;
  readonly reason: string;
  readonly now: number;
  readonly auditId: string;
}

/**
 * Apply a human rejection. Removes the pending draft and produces the audit
 * record. `decidedBy` is left for the caller to attribute; the audit record
 * always carries the human-facing reason.
 */
export function rejectDraftFromQueue(
  state: ReviewQueueState,
  input: RejectInput,
  decidedBy: string,
): DecisionOutcome {
  const target = state.pendingDrafts.find((p) => p.workflowId === input.workflowId);
  if (target === undefined) return { ok: false, error: "not_found" };

  return {
    ok: true,
    state: {
      pendingDrafts: state.pendingDrafts.filter((p) => p.workflowId !== input.workflowId),
      drafts: state.drafts,
    },
    record: {
      id: input.auditId,
      workflowId: input.workflowId,
      decision: "rejected",
      decidedBy,
      decidedAt: input.now,
      reason: input.reason,
    },
  };
}

/** Whether a workflow still has a draft awaiting a human decision. */
export function isPending(state: ReviewQueueState, workflowId: string): boolean {
  return state.pendingDrafts.some((p) => p.workflowId === workflowId);
}

function replaceById(drafts: ReadonlyArray<PendingDraft>, next: PendingDraft): ReadonlyArray<PendingDraft> {
  const withoutOld = drafts.filter((d) => d.workflowId !== next.workflowId);
  return [...withoutOld, next];
}
