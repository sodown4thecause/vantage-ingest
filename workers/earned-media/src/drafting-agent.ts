// ---------------------------------------------------------------------------
// DraftingAgent: a Durable Object (the Agents SDK `Agent` base) that owns the
// human-in-the-loop review queue for earned-media drafts.
//
// State (`initialState`) is the pending-drafts review queue. Decisions are
// audited durably in a SQLite table created and written via `this.sql`. The RPC
// surface for humans is `@callable()` methods that call the SDK's
// `approveWorkflow` / `rejectWorkflow`, which is what actually unblocks the
// workflow's `waitForApproval`.
//
// There is no method here that posts anything. Approval resumes a workflow;
// posting is a separate, approval-gated step.
// ---------------------------------------------------------------------------
import { Agent, callable } from "agents";
import { getDraftConfig, type DetectedSignal, type Env, type EarnedMediaWorkflowParams } from "./env";
import { parseDraftResponse, type EarnedMediaDraft } from "./draft-schema";
import { buildDraftPrompt } from "./draft-prompt";
import { createIncoClient } from "./inco-client";
import {
  approveDraftFromQueue,
  enqueueDraft,
  INITIAL_REVIEW_QUEUE,
  isPending,
  rejectDraftFromQueue,
  toPendingDraft,
  type AuditRecord,
  type ReviewQueueState,
} from "./review-queue";

/** SDK binding name from `wrangler.toml`; passed to `runWorkflow`. */
export const EARNED_MEDIA_WORKFLOW_BINDING = "EARNED_MEDIA_WORKFLOW" as const;

/** Result returned to a human when they approve a draft. */
export interface ApprovalResult {
  readonly workflowId: string;
  readonly approvedBy: string;
  readonly edited: boolean;
}

/**
 * The drafting agent.
 *
 * Lifecycle: the agent is name-addressed (see the worker entry's `fetch`), which
 * is required for the SDK to route workflow callbacks back to it.
 */
export class DraftingAgent extends Agent<Env, ReviewQueueState> {
  /** The review queue. Starts empty; `onWorkflowProgress` fills it. */
  override initialState: ReviewQueueState = INITIAL_REVIEW_QUEUE;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Audit table for human decisions. Created on every wake; idempotent.
    this.sql`
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT ''
      )
    `;
  }

  /**
   * Create a draft from a detected signal and start the human-in-the-loop
   * workflow. Returns the workflow instance id, which is the key humans use to
   * approve or reject the draft.
   */
  async createDraft(signal: DetectedSignal): Promise<{ readonly workflowId: string }> {
    const workflowId = await this.runWorkflow<EarnedMediaWorkflowParams>(
      EARNED_MEDIA_WORKFLOW_BINDING,
      { signal },
    );
    return { workflowId };
  }

  /**
   * Approve a pending draft. Calls the SDK's `approveWorkflow`, which wakes the
   * workflow's `waitForApproval`. `editedText`, when supplied by the human,
   * replaces the draft body; the final text still carries the disclosure line.
   */
  @callable()
  async approve(workflowId: string, approvedBy: string, editedText?: string): Promise<ApprovalResult> {
    if (approvedBy.trim() === "") {
      throw new Error("approval requires a non-empty approver");
    }
    if (!isPending(this.state, workflowId)) {
      throw new Error(`no pending draft for workflow ${workflowId}`);
    }

    const outcome = approveDraftFromQueue(this.state, {
      workflowId,
      approvedBy,
      ...(editedText !== undefined ? { editedText } : {}),
      now: Date.now(),
      auditId: crypto.randomUUID(),
    });
    if (!outcome.ok) throw new Error(`no pending draft for workflow ${workflowId}`);

    this.setState(outcome.state);
    this.recordAudit(outcome.record);

    // SDK call: resume the paused workflow. Nothing is posted by the agent.
    await this.approveWorkflow(workflowId, {
      reason: "Approved by human reviewer",
      metadata: {
        approvedBy,
        edited: editedText !== undefined && editedText.trim() !== "",
      },
    });

    return {
      workflowId,
      approvedBy,
      edited: editedText !== undefined && editedText.trim() !== "",
    };
  }

  /**
   * Reject a pending draft. Calls the SDK's `rejectWorkflow`, which makes the
   * workflow's `waitForApproval` throw `WorkflowRejectedError` — so the post
   * step is never reached.
   */
  @callable()
  async reject(workflowId: string, reason: string): Promise<{ readonly workflowId: string }> {
    const rejectedBy = "human-reviewer";
    const outcome = rejectDraftFromQueue(
      this.state,
      { workflowId, reason, now: Date.now(), auditId: crypto.randomUUID() },
      rejectedBy,
    );
    if (!outcome.ok) throw new Error(`no pending draft for workflow ${workflowId}`);

    this.setState(outcome.state);
    this.recordAudit(outcome.record);

    // SDK call: reject the paused workflow so its `post` step never runs.
    await this.rejectWorkflow(workflowId, { reason });
    return { workflowId };
  }

  /**
   * The agent's read view of the queue: pending drafts plus a count of recorded
   * decisions. `@callable()` so a reviewer UI can read it over RPC.
   */
  @callable()
  listPending(): { readonly pending: ReadonlyArray<unknown>; readonly auditedDecisions: number } {
    const rows = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM audit`;
    return {
      pending: this.state.pendingDrafts,
      auditedDecisions: rows[0]?.count ?? 0,
    };
  }

  /** Read the audit trail for one workflow. `@callable()` for reviewer UIs. */
  @callable()
  auditFor(workflowId: string): ReadonlyArray<AuditRecord> {
    return this.sql<AuditRecord>`
      SELECT id, workflow_id AS workflowId, decision, decided_by AS decidedBy,
             decided_at AS decidedAt, reason
      FROM audit
      WHERE workflow_id = ${workflowId}
      ORDER BY decided_at ASC
    `;
  }

  /**
   * Workflow progress hook. When the workflow reports a pending draft, the
   * agent merges it into the review queue and persists the audited event. This
   * is the ONLY way a draft enters the queue; nothing posts here.
   */
  override async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: unknown,
  ): Promise<void> {
    const event = parseSurfaceProgress(progress, workflowId);
    if (event === null) return;
    this.setState(enqueueDraft(this.state, toPendingDraft(event)));
  }

  /** Persist a human decision to the durable audit table. */
  private recordAudit(record: AuditRecord): void {
    this.sql`
      INSERT OR REPLACE INTO audit (id, workflow_id, decision, decided_by, decided_at, reason)
      VALUES (${record.id}, ${record.workflowId}, ${record.decision}, ${record.decidedBy}, ${record.decidedAt}, ${record.reason})
    `;
  }

  /**
   * Draft a comment for a signal using the configured writer model. Exposed for
   * the workflow's durable `draft` step. Validates untrusted output with zod.
   */
  async draftComment(signal: DetectedSignal): Promise<EarnedMediaDraft> {
    const apiKey = this.env.INCO_API_KEY;
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new Error("INCO_API_KEY is not configured");
    }
    const config = getDraftConfig(this.env);
    const client = createIncoClient({ apiKey });
    const result = await client.chat({
      model: config.model,
      messages: buildDraftPrompt(signal),
      responseFormat: "json",
    });
    const parsed = parseDraftResponse(result.content, config.disclosureEnabled);
    if (!parsed.ok) {
      throw new Error(`draft model returned an invalid draft: ${parsed.reason}`);
    }
    return parsed.draft;
  }
}

/** Shape of the `surface-to-review` progress event the workflow emits. */
interface SurfaceEvent {
  readonly workflowId: string;
  readonly signal: { readonly title: string; readonly url: string; readonly platform: string };
  readonly draft: EarnedMediaDraft;
  readonly now: number;
}

/**
 * Parse the untrusted progress payload into a surface event, or null when it is
 * not a surface event. Progress payloads are a boundary: only a well-formed
 * event is accepted, so a malformed one can never corrupt the queue.
 */
function parseSurfaceProgress(progress: unknown, workflowId: string): SurfaceEvent | null {
  if (typeof progress !== "object" || progress === null) return null;
  const p = progress as Record<string, unknown>;
  if (p["step"] !== "surface-to-review") return null;
  const draft = p["draft"];
  if (typeof draft !== "object" || draft === null) return null;
  const d = draft as Record<string, unknown>;
  const body = typeof d["body"] === "string" ? d["body"] : "";
  const rationale = typeof d["rationale"] === "string" ? d["rationale"] : "";
  const disclosureLine = typeof d["disclosureLine"] === "string" ? d["disclosureLine"] : "";
  if (body.trim() === "") return null;
  const title = typeof p["signalTitle"] === "string" ? p["signalTitle"] : "";
  const url = typeof p["signalUrl"] === "string" ? p["signalUrl"] : "";
  const platform = typeof p["platform"] === "string" ? p["platform"] : "other";
  return {
    workflowId,
    signal: { title, url, platform },
    draft: { body, rationale, disclosureLine },
    now: typeof p["now"] === "number" ? p["now"] : Date.now(),
  };
}
