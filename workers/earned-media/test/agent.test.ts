// ---------------------------------------------------------------------------
// Hermetic tests for the earned-media drafting agent's PURE pieces.
//
// No network, no Durable Object, no Workers runtime. These cover the invariants
// the human-in-the-loop guarantee rests on: draft validation + disclosure
// default, review-queue state transitions, the audit-record shape, and the
// approval-gated poster that never posts without a credential.
//
// Run: npm run smoke   (in workers/earned-media)
// ---------------------------------------------------------------------------
import {
  composeDraftText,
  DEFAULT_DISCLOSURE_LINE,
  parseDraftResponse,
  resolveDisclosureLine,
} from "../src/draft-schema.ts";
import { buildDraftPrompt } from "../src/draft-prompt.ts";
import {
  approveDraftFromQueue,
  enqueueDraft,
  INITIAL_REVIEW_QUEUE,
  isPending,
  rejectDraftFromQueue,
  toPendingDraft,
} from "../src/review-queue.ts";
import { createRecordingPoster, toApprovedPost } from "../src/posting.ts";
import { getDraftConfig, DEFAULT_WRITER_MODEL } from "../src/env.ts";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok:   ${label}`);
  }
}

const signal = {
  title: "Anyone else find Cursor's context window confusing?",
  url: "https://news.ycombinator.com/item?id=1",
  platform: "hackernews",
  snippet: "I keep losing context mid-file...",
};

// --- Draft validation + disclosure invariant --------------------------------
{
  check(
    "schema: accepts a well-formed draft",
    parseDraftResponse('{"body":"Here is a concrete tip.","rationale":"useful"}', true).ok === true,
  );
  check(
    "schema: rejects empty body",
    parseDraftResponse('{"body":"   "}', true).ok === false,
  );
  check(
    "schema: rejects malformed JSON",
    parseDraftResponse("not json at all", true).ok === false,
  );
  check(
    "schema: strips ```json fences",
    parseDraftResponse('```json\n{"body":"Useful.","rationale":"r"}\n```', true).ok === true,
  );

  // DEFAULT ON: a missing disclosure line is supplied, never omitted.
  const missing = parseDraftResponse('{"body":"Useful body.","rationale":"r"}', true);
  check(
    "disclosure: missing line is filled when enabled (default on)",
    missing.ok === true && missing.draft.disclosureLine === DEFAULT_DISCLOSURE_LINE,
  );
  check(
    "disclosure: composed text always carries the disclosure when enabled",
    missing.ok === true && composeDraftText(missing.draft).includes(DEFAULT_DISCLOSURE_LINE),
  );

  // The model's own line is preserved verbatim.
  const supplied = parseDraftResponse(
    '{"body":"b","disclosureLine":"Disclosure: I work on this project."}',
    true,
  );
  check(
    "disclosure: model-supplied line is preserved",
    supplied.ok === true && supplied.draft.disclosureLine === "Disclosure: I work on this project.",
  );

  // Explicit opt-out removes it entirely.
  const off = parseDraftResponse('{"body":"b"}', false);
  check(
    "disclosure: explicit opt-out removes the line",
    off.ok === true && off.draft.disclosureLine === "",
  );
  check(
    "disclosure: resolve is total for (undefined, on)",
    resolveDisclosureLine(undefined, true) === DEFAULT_DISCLOSURE_LINE,
  );
  check(
    "disclosure: resolve is total for (supplied, off)",
    resolveDisclosureLine("ignored", false) === "",
  );
}

// --- Review-queue state transitions -----------------------------------------
{
  const draft = {
    body: "A genuinely useful reply.",
    rationale: "answers the question",
    disclosureLine: DEFAULT_DISCLOSURE_LINE,
  };

  const empty = INITIAL_REVIEW_QUEUE;
  check("queue: initialState has no pending drafts", empty.pendingDrafts.length === 0);

  const pending = enqueueDraft(
    empty,
    toPendingDraft({ workflowId: "wf-1", signal, draft, now: 1_000 }),
  );
  check("queue: enqueue adds one pending draft", pending.pendingDrafts.length === 1);
  check("queue: pending draft is keyed by workflowId", isPending(pending, "wf-1"));
  check("queue: unknown workflow is not pending", !isPending(pending, "wf-x"));

  // Idempotent re-enqueue (workflow step retry) does not duplicate.
  const reEnqueued = enqueueDraft(
    pending,
    toPendingDraft({ workflowId: "wf-1", signal, draft, now: 2_000 }),
  );
  check("queue: re-enqueue is idempotent per workflowId", reEnqueued.pendingDrafts.length === 1);

  // Approve removes the pending draft and yields an audit record.
  const approved = approveDraftFromQueue(pending, {
    workflowId: "wf-1",
    approvedBy: "alice",
    now: 3_000,
    auditId: "audit-1",
  });
  check("queue: approve succeeds for a pending workflow", approved.ok === true);
  if (approved.ok) {
    check("queue: approve clears the pending draft", !isPending(approved.state, "wf-1"));
    check("queue: approve still keeps the draft record", approved.state.drafts.length === 1);
    check("audit: decision is approved", approved.record.decision === "approved");
    check("audit: decidedBy is recorded", approved.record.decidedBy === "alice");
    check("audit: decidedAt is recorded", approved.record.decidedAt === 3_000);
    check("audit: id is recorded", approved.record.id === "audit-1");
    check("audit: final text carries the disclosure", composeDraftText(draft).includes(DEFAULT_DISCLOSURE_LINE));
  }

  // Approve on an empty / already-decided queue fails loud, no double decision.
  const double = approveDraftFromQueue(approved.ok ? approved.state : pending, {
    workflowId: "wf-1",
    approvedBy: "bob",
    now: 4_000,
    auditId: "audit-2",
  });
  check("queue: a second approve is refused (not_found)", double.ok === false);

  // Reject removes pending without adding to drafts.
  const rejected = rejectDraftFromQueue(
    pending,
    { workflowId: "wf-1", reason: "off-topic", now: 5_000, auditId: "audit-3" },
    "carol",
  );
  check("queue: reject succeeds for a pending workflow", rejected.ok === true);
  if (rejected.ok) {
    check("queue: reject clears the pending draft", !isPending(rejected.state, "wf-1"));
    check("queue: reject does not add an approved draft", rejected.state.drafts.length === 0);
    check("audit: decision is rejected", rejected.record.decision === "rejected");
    check("audit: rejection reason is recorded", rejected.record.reason === "off-topic");
  }

  // Human edit replaces the body but keeps the disclosure line.
  const edited = approveDraftFromQueue(pending, {
    workflowId: "wf-1",
    approvedBy: "dave",
    editedText: "Human-edited body.",
    now: 6_000,
    auditId: "audit-4",
  });
  check(
    "queue: human edit replaces the draft body",
    edited.ok === true && edited.state.drafts[0]?.body === "Human-edited body.",
  );
  check(
    "queue: human edit keeps the disclosure line",
    edited.ok === true && edited.state.drafts[0]?.disclosureLine === DEFAULT_DISCLOSURE_LINE,
  );
}

// --- Posting is approval-gated and never posts without a credential ---------
{
  const draft = {
    body: "Useful reply.",
    rationale: "",
    disclosureLine: DEFAULT_DISCLOSURE_LINE,
  };

  const recorded: { value: { posted: boolean } | null } = { value: null };
  const poster = createRecordingPoster({
    recordDecision: (_approved, result) => {
      recorded.value = { posted: result.posted };
    },
  });
  const approved = toApprovedPost({
    workflowId: "wf-1",
    platform: "hackernews",
    url: signal.url,
    title: signal.title,
    draft,
    approvedBy: "alice",
    approvedAt: 7_000,
  });
  const result = await poster.post(approved);
  check("poster: no credential means nothing is posted", result.posted === false);
  check("poster: outcome is not_posted_no_credential", result.outcome === "not_posted_no_credential");
  check("poster: recorded flag reflects no post", recorded.value !== null && recorded.value.posted === false);
  check("poster: composed approved body carries the disclosure", approved.body.includes(DEFAULT_DISCLOSURE_LINE));

  // Fail loud: a post with no approver is refused outright.
  let threw = false;
  try {
    await poster.post({ ...approved, approvedBy: "" });
  } catch {
    threw = true;
  }
  check("poster: refuses to post without an approver (fail loud)", threw);

  // Even WITH a credential, this repo ships no real posting implementation.
  const credentialPoster = createRecordingPoster({ hasCredential: true });
  const credentialResult = await credentialPoster.post(approved);
  check("poster: real posting is not implemented even with a credential", credentialResult.posted === false);
}

// --- Draft prompt purity ----------------------------------------------------
{
  const a = buildDraftPrompt(signal);
  const b = buildDraftPrompt(signal);
  check("prompt: pure — same signal yields deep-equal messages", JSON.stringify(a) === JSON.stringify(b));
  check("prompt: includes the discussion title", a[1]?.content.includes(signal.title) === true);
  check("prompt: marks the discussion as untrusted", a[1]?.content.includes("untrusted") === true);
  check("prompt: instructs disclosure", a[0]?.content.toLowerCase().includes("disclos") === true);
  check("prompt: forbids astroturfing", a[0]?.content.toLowerCase().includes("astroturf") === true);
}

// --- Config parsing ---------------------------------------------------------
{
  check("config: default writer model is kimi-k3", getDraftConfig({}).model === DEFAULT_WRITER_MODEL);
  check("config: disclosure defaults to enabled", getDraftConfig({}).disclosureEnabled === true);
  check(
    "config: disclosure can be explicitly disabled",
    getDraftConfig({ DRAFT_DISCLOSURE_ENABLED: "false" }).disclosureEnabled === false,
  );
  check(
    "config: only the literal 'false' disables disclosure",
    getDraftConfig({ DRAFT_DISCLOSURE_ENABLED: "0" }).disclosureEnabled === true,
  );
  check(
    "config: writer model can be overridden",
    getDraftConfig({ INCO_WRITER_MODEL: "some-model" }).model === "some-model",
  );
}

if (failures > 0) {
  // Throwing (rather than process.exit) keeps the test free of Node typings.
  throw new Error(`${failures} check(s) failed`);
}
console.log("\nall checks passed");
