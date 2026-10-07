# vantage-earned-media — human-in-the-loop earned-media DRAFTING agent

A **separate** Cloudflare Worker that turns a detected discussion into a **draft**
comment for a human to review, edit, and approve — and only *then* may anything be
posted. It is built on Cloudflare's [Agents SDK](https://developers.cloudflare.com/agents/)
(`agents@0.26.0`) and a durable Workflow.

> **This worker does not auto-post. It cannot auto-post.**
> There is no posting credential, no default post path, and no scheduled post. A
> human performs the real action. This is an anti-astroturfing design, not a
> configuration.

---

## Why this is a separate worker

The root ingest worker pins `zod@^3.25.76`. `agents@0.26.0` requires `zod@^4`.
Rather than upgrade the ingest worker's zod (or use `--legacy-peer-deps`/`--force`),
the agent lives in its own worker with its **own** `package.json`, `wrangler.toml`,
`tsconfig.json`, and dependency tree. The small `inco-client` pattern is copied
into this worker (see `src/inco-client.ts`) rather than imported from the root, so
the two package trees stay fully independent and neither worker's build can reach
into the other. The root `tsconfig.json` only includes `src/**` and `scripts/**`,
so this directory is never typechecked by the root project.

---

## The human-in-the-loop guarantee

Data flow, enforced by construction:

```
POST /draft  ──▶  DraftingAgent.createDraft()
                       │  runWorkflow("EARNED_MEDIA_WORKFLOW", { signal })
                       ▼
              EarnedMediaWorkflow.run()
                       │
   step 1  step.do("draft")            ← LLM drafts; zod-validated; disclosed
                       │
   step 2  reportProgress(...)         ← surfaces the draft to the review queue
           step.mergeAgentState(...)      (DraftingAgent.onWorkflowProgress)
                       │
   step 3  waitForApproval(step, { timeout: "7 days" })
                       │  paused until a human calls approve() or reject()
        ┌──────────────┴──────────────┐
   approve                          reject / timeout
        │                                │
   step 4  step.do("post")          return without posting
           (approval-gated stub)     (WorkflowRejectedError or undefined)
```

- **Only a human decision leaves the `pending` queue.** The pure transitions in
  `src/review-queue.ts` have exactly two exits — `approveDraftFromQueue` and
  `rejectDraftFromQueue` — and both require an explicit reviewer identity.
- **The post step is only reachable after approval.** A timeout makes
  `waitForApproval` resolve `undefined`; a rejection makes it throw
  `WorkflowRejectedError`. Both branches return **before** `step.do("post")`.
- **The poster is a stub.** `createRecordingPoster()` has no credential, so
  `post()` returns `{ posted: false, outcome: "not_posted_no_credential" }` and
  records the approved decision. It throws outright if given a post with no
  approver. Real platform posting is intentionally absent.

### Disclosure is default ON

Every persisted draft carries an AI/brand **disclosure line**. When the model
omits one, the canonical line in `src/draft-schema.ts` is substituted — a draft
without a disclosure is not a valid draft. Only `DRAFT_DISCLOSURE_ENABLED="false"`
(the literal string) opts out, and that is not recommended.

### Review queue + audit design

- **State** (`initialState`) holds the pending-drafts review queue
  (`pendingDrafts`) plus the human-decided drafts (`drafts`).
- **Audit table** (`audit`, created and written via `this.sql`) records every
  human decision: `(id, workflow_id, decision, decided_by, decided_at, reason)`.
  The queue is mutable; the audit trail is the durable record of *who decided
  what and when*.
- `@callable()` methods exposed over DO RPC:
  - `approve(workflowId, approvedBy, editedText?)` — human edit wins; disclosure
    is retained; calls the SDK's `approveWorkflow`.
  - `reject(workflowId, reason)` — calls the SDK's `rejectWorkflow`.
  - `listPending()` / `auditFor(workflowId)` — read views for a reviewer UI.

---

## Deploying this worker separately

This worker is deployed on its own; it does **not** share config or bindings with
the root ingest worker.

```bash
cd workers/earned-media
npm install

# Secret: the inference key is never committed and never logged.
npx wrangler secret put INCO_API_KEY

# Local dev
npm run dev

# Typecheck + hermetic tests (no network / DO)
npm run typecheck
npm run smoke

# Dry-run bundle check, then deploy
npx wrangler deploy --dry-run
npm run deploy
```

### Environment

| Var | Kind | Default | Meaning |
|-----|------|---------|---------|
| `INCO_API_KEY` | **secret** | — | Inference key. Read only from `env.INCO_API_KEY`. |
| `INCO_WRITER_MODEL` | var | `"kimi-k3"` | Writer model id. |
| `DRAFT_DISCLOSURE_ENABLED` | var | `"true"` | `"false"` disables the disclosure line. |

### Bindings (`wrangler.toml`)

| Binding | Type | Purpose |
|---------|------|---------|
| `DRAFTING_AGENT` | Durable Object | The review queue + audit table. Created via `new_sqlite_classes`. |
| `EARNED_MEDIA_WORKFLOW` | Workflow | The durable draft → review → post run. |

`compatibility_flags = ["nodejs_compat"]` is required by the Agents SDK. The
`new_sqlite_classes` migration is required because the agent stores its queue in
embedded SQLite via `this.sql`.

---

## HTTP surface

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness. |
| `POST` | `/draft` | Body `{ title, url, platform, snippet }`. Creates a draft and starts the HITL workflow. Returns `{ workflowId, status: "awaiting-human" }`. |
| `*` | `/agents/:binding/:name[/...]` | Agents SDK routing for DO RPC (approve/reject/list) and WebSockets. |

---

## What is stubbed / needs live verification

- **Real platform posting is stubbed.** No Reddit/HN/forum API client exists. The
  approval-gated seam (`src/posting.ts`) records the approved decision and does
  not post. Wiring a real poster must preserve the "only after approval" gate.
- **Writer model id.** `INCO_WRITER_MODEL` defaults to `kimi-k3` (the id used by
  the root worker's writer seam, verified against `GET https://api.inco.ai/v1/models`
  on 2026-10-07). Confirm it is still served before relying on it.
- **Live deploy.** Durable Objects, Workflows, and the 7-day approval wait are
  verified here only by typecheck, hermetic pure-logic tests, and a bundle
  dry-run. A live `wrangler deploy` + a real draft/approve cycle has not been run
  in this environment.
