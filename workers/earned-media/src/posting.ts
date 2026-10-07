// ---------------------------------------------------------------------------
// Approval-gated posting seam.
//
// THE CENTRAL SAFETY PROPERTY OF THIS WORKER:
//
//   Nothing in this file posts anything on its own. Posting is reachable ONLY
//   through `postApprovedDraft`, which is called ONLY from the workflow's
//   `post` step, which runs ONLY after a human approval has been received via
//   `waitForApproval`. There is no scheduled, retried, or default path that
//   reaches a post without a recorded human approval.
//
// There is intentionally NO real posting credential and NO auto-post codepath.
// A human operates the real action; this module records the approved decision.
// ---------------------------------------------------------------------------
import { composeDraftText, type EarnedMediaDraft } from "./draft-schema";

/** The approved action the workflow hands to the poster. */
export interface ApprovedPost {
  readonly workflowId: string;
  readonly platform: string;
  readonly url: string;
  readonly title: string;
  /** The final text, including the disclosure line. */
  readonly body: string;
  /** Who approved it. Required; a post cannot exist without an approver. */
  readonly approvedBy: string;
  /** Unix ms of the approval decision. */
  readonly approvedAt: number;
}

/** Result of attempting the post. `posted: false` is the expected default today. */
export interface PostResult {
  /** Whether the text was actually published to a platform. */
  readonly posted: boolean;
  /** Machine-readable outcome, safe to log and store. */
  readonly outcome: "not_posted_no_credential" | "not_posted_disabled" | "posted";
  /** Human-readable note. Never contains secrets. */
  readonly message: string;
}

/** The posting seam. Implementations decide whether a real post can happen. */
export interface Poster {
  post(approved: ApprovedPost): Promise<PostResult>;
}

/** Options for {@link createRecordingPoster}. */
export interface RecordingPosterOptions {
  /**
   * Whether a real platform credential is configured. There is no real
   * credential in this repository, so this defaults to `false`; with no
   * credential the poster NEVER posts — it records the approved decision only.
   */
  readonly hasCredential?: boolean;
  /** Injection seam for a future real implementation / tests. */
  readonly recordDecision?: (approved: ApprovedPost, result: PostResult) => Promise<void> | void;
}

/**
 * The default poster: an approval-gated STUB.
 *
 * With no credential (the only supported configuration today) it does not post.
 * It returns `not_posted_no_credential` and records the approved decision. This
 * is the deliberate anti-astroturfing default: the agent CANNOT publish.
 */
export function createRecordingPoster(options: RecordingPosterOptions = {}): Poster {
  const hasCredential = options.hasCredential ?? false;

  return {
    async post(approved: ApprovedPost): Promise<PostResult> {
      // Fail fast if the caller ever constructs a post without an approval —
      // this is the last line of defence before any platform call could happen.
      if (approved.approvedBy.trim() === "") {
        throw new Error("refusing to post: no approver recorded");
      }

      if (!hasCredential) {
        const result: PostResult = {
          posted: false,
          outcome: "not_posted_no_credential",
          message:
            "No posting credential configured; the approved decision was recorded for a human to post.",
        };
        await options.recordDecision?.(approved, result);
        return result;
      }

      // Even with a credential, a real implementation would live here and MUST
      // still only be reachable through this approval-gated call. No such
      // implementation ships in this repository.
      const result: PostResult = {
        posted: false,
        outcome: "not_posted_disabled",
        message: "Real posting is not implemented in this repository; a human performs the post.",
      };
      await options.recordDecision?.(approved, result);
      return result;
    },
  };
}

/** Build an {@link ApprovedPost} from an approved draft. Pure and total. */
export function toApprovedPost(input: {
  readonly workflowId: string;
  readonly platform: string;
  readonly url: string;
  readonly title: string;
  readonly draft: EarnedMediaDraft;
  readonly approvedBy: string;
  readonly approvedAt: number;
}): ApprovedPost {
  return {
    workflowId: input.workflowId,
    platform: input.platform,
    url: input.url,
    title: input.title,
    body: composeDraftText(input.draft),
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
  };
}
