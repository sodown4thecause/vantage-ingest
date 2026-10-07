// ---------------------------------------------------------------------------
// Worker entry for the earned-media drafting agent (isolated worker).
//
// HTTP surface, minimal by design:
//   POST /draft        -> create a draft + start the HITL workflow
//   GET  /health       -> liveness
//   /agents/*          -> Agents SDK routing (DO RPC for approve/reject/list)
//
// Nothing here posts. `POST /draft` only DRAFTS and starts a workflow that
// pauses for a human.
// ---------------------------------------------------------------------------
import { routeAgentRequest } from "agents";
import { DraftingAgent } from "./drafting-agent";
import { EarnedMediaWorkflow } from "./workflow";
import type { DetectedSignal, Env } from "./env";

// The Agents SDK requires the Durable Object and Workflow classes to be exported
// from the worker entry so the runtime can bind them by class name.
export { DraftingAgent, EarnedMediaWorkflow };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Parse one untrusted draft request into a trusted {@link DetectedSignal}. */
function parseSignal(raw: unknown): DetectedSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r["title"] === "string" ? r["title"].trim() : "";
  const url = typeof r["url"] === "string" ? r["url"].trim() : "";
  const snippet = typeof r["snippet"] === "string" ? r["snippet"].trim() : "";
  const platform = typeof r["platform"] === "string" && r["platform"].trim() !== "" ? r["platform"].trim() : "other";
  if (title === "" || url === "") return null;
  return { title, url, snippet, platform };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/draft") {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const signal = parseSignal(payload);
      if (signal === null) {
        return json({ error: "expected { title, url, platform, snippet }" }, 400);
      }

      // Name-addressed agent is REQUIRED for workflow callbacks to route back.
      const agent = env.DRAFTING_AGENT.getByName("review-queue");
      const { workflowId } = await agent.createDraft(signal);
      return json({ workflowId, status: "awaiting-human", signal }, 202);
    }

    // Agents SDK routing: /agents/:binding/:name[/...] for DO RPC + WebSockets.
    const routed = await routeAgentRequest(request, env);
    if (routed !== null) return routed;

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
