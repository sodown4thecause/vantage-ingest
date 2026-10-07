// ---------------------------------------------------------------------------
// EarnedMediaWorkflow: the durable, human-in-the-loop run.
//
// Ordering is load-bearing and enforced by construction:
//   1. step.do("draft")          -> produce a draft (durable, retried)
//   2. surface to review queue   -> reportProgress + mergeAgentState (durable)
//   3. waitForApproval           -> pause for a human; 7-day timeout
//   4. step.do("post")           -> ONLY on approval
//
// There is no path from draft to post that skips step 3. A timeout yields
// `undefined` and a rejection throws `WorkflowRejectedError`; in BOTH cases the
// post step is never invoked.
// ---------------------------------------------------------------------------
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { WorkflowRejectedError } from "agents/workflows";
import type { DraftingAgent } from "./drafting-agent";
import { EARNED_MEDIA_WORKFLOW_BINDING } from "./drafting-agent";
import type { DetectedSignal, EarnedMediaWorkflowParams } from "./env";
import { createRecordingPoster, toApprovedPost } from "./posting";
import type { EarnedMediaDraft } from "./draft-schema";

/** How long a draft waits for a human before the request expires. */
export const APPROVAL_TIMEOUT = "7 days" as const;

/** Human approval payload received from `approveWorkflow`. */
interface ApprovalPayload {
  readonly approvedBy?: string;
  readonly metadata?: { readonly approvedBy?: string; readonly edited?: boolean };
}

/** Outcome the workflow records when it finishes (or expires) without posting. */
export type WorkflowOutcome =
  | { readonly status: "awaiting-human" }
  | { readonly status: "expired-without-approval" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "approved-not-posted"; readonly outcome: string }
  | { readonly status: "posted" };

/**
 * The workflow. It can only ever DRAFT and record; it can never post without a
 * human approval, and today it never posts at all (no credential exists).
 */
export class EarnedMediaWorkflow extends AgentWorkflow<DraftingAgent, EarnedMediaWorkflowParams> {
  override async run(
    event: AgentWorkflowEvent<EarnedMediaWorkflowParams>,
    step: AgentWorkflowStep,
  ): Promise<WorkflowOutcome> {
    const signal: DetectedSignal = event.payload.signal;

    // Step 1 — draft. Durable: retries on failure, output is memoized.
    const draft = await step.do("draft", async (): Promise<EarnedMediaDraft> => {
      return this.agent.draftComment(signal);
    });

    // Step 2 — surface to the human review queue. `reportProgress` is a
    // non-durable, lightweight signal that the agent turns into a queue entry.
    await this.reportProgress({
      step: "surface-to-review",
      status: "pending",
      message: `Draft ready for review: ${signal.title}`,
      signalTitle: signal.title,
      signalUrl: signal.url,
      platform: signal.platform,
      draft,
      now: Date.now(),
    });

    // Durable mirror of the draft into agent state (idempotent per step name).
    await step.mergeAgentState({
      lastSurfaced: { workflowId: this.workflowId, signalTitle: signal.title },
    });

    // Step 3 — wait for a human. Rejection throws; timeout yields undefined.
    let approval: ApprovalPayload | undefined;
    try {
      approval = await this.waitForApproval<ApprovalPayload>(step, { timeout: APPROVAL_TIMEOUT });
    } catch (error: unknown) {
      if (error instanceof WorkflowRejectedError) {
        // Human said no. Record and stop — the post step is never reached.
        await step.mergeAgentState({
          lastDecision: { workflowId: this.workflowId, decision: "rejected" },
        });
        return { status: "rejected", reason: error.reason ?? "rejected" };
      }
      throw error;
    }

    if (approval === undefined) {
      // Timeout: no human decision within the window. Do NOT post.
      await step.mergeAgentState({
        lastDecision: { workflowId: this.workflowId, decision: "expired" },
      });
      return { status: "expired-without-approval" };
    }

    const approvedBy = approval.approvedBy ?? approval.metadata?.approvedBy ?? "human-reviewer";

    // Step 4 — ONLY here, and only after approval, may posting be attempted.
    // The poster is a stub with no credential, so the default is NOT to post.
    const outcome = await step.do("post", async (): Promise<WorkflowOutcome> => {
      const poster = createRecordingPoster();
      const approved = toApprovedPost({
        workflowId: this.workflowId,
        platform: signal.platform,
        url: signal.url,
        title: signal.title,
        draft,
        approvedBy,
        approvedAt: Date.now(),
      });
      const result = await poster.post(approved);
      return result.posted
        ? { status: "posted" }
        : { status: "approved-not-posted", outcome: result.outcome };
    });

    return outcome;
  }
}

/** Re-exported so the worker bundle keeps the workflow binding name in sync. */
export { EARNED_MEDIA_WORKFLOW_BINDING };
