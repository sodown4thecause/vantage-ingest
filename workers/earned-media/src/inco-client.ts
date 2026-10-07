// ---------------------------------------------------------------------------
// `inco` inference client (agent-worker copy).
//
// DELIBERATE DUPLICATION: the root ingest worker keeps its own copy of this
// client at `src/inco/client.ts`. We copy the small pattern here instead of
// importing across worker directories so the two package trees (zod@3 vs zod@4)
// stay fully independent and neither worker's build can reach into the other.
//
// Single-host, OpenAI-compatible chat-completions API called with plain
// `fetch()` (no OpenAI Node SDK). Model-agnostic: callers pass the model id.
//
// Security: the API key comes ONLY from the caller-provided key. It is never
// logged, never embedded in error messages, and never returned to callers.
// ---------------------------------------------------------------------------

/** Base URL of the OpenAI-compatible inference host (no trailing slash). */
export const INCO_BASE_URL = "https://api.inco.ai/v1";

/** Chat-completions request. Deliberately narrow. */
export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  /** Sampling temperature. Omit to use the provider default. */
  readonly temperature?: number;
  /** Ask for JSON output mode when true. */
  readonly responseFormat?: "json";
  /** Abort the request after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Max attempts including the first. Retries only on 429/5xx/network. */
  readonly maxAttempts?: number;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Token accounting as reported by the provider, when present. */
export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** A successfully parsed chat-completions response. */
export interface ChatResult {
  /** Assistant message content (untrusted text; callers still validate it). */
  readonly content: string;
  readonly model: string;
  readonly usage: Usage | null;
  readonly status: number;
}

/** The client seam. Pure logic depends on this interface, not the fetch impl. */
export interface IncoClient {
  chat(request: ChatRequest): Promise<ChatResult>;
}

/** Error thrown for any non-success from the inference host. Never includes the key. */
export class IncoError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly kind: "http" | "network" | "timeout" | "shape";

  constructor(
    message: string,
    options: {
      readonly status?: number | null;
      readonly retryable: boolean;
      readonly kind: IncoError["kind"];
    },
  ) {
    super(message);
    this.name = "IncoError";
    this.status = options.status ?? null;
    this.retryable = options.retryable;
    this.kind = options.kind;
  }
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/** True for HTTP statuses worth retrying: rate limits and transient server faults. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort usage extraction; unrecognized shapes yield null, never a fabrication. */
function parseUsage(raw: unknown): Usage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const prompt = u["prompt_tokens"];
  const completion = u["completion_tokens"];
  const total = u["total_tokens"];
  if (typeof prompt !== "number" || typeof completion !== "number") return null;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: typeof total === "number" ? total : prompt + completion,
  };
}

/** Extract assistant content from an OpenAI-compatible body, or null if unexpected. */
function parseContent(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const choices = (raw as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}

function parseModel(raw: unknown, fallback: string): string {
  if (typeof raw !== "object" || raw === null) return fallback;
  const model = (raw as Record<string, unknown>)["model"];
  return typeof model === "string" && model !== "" ? model : fallback;
}

export interface IncoClientOptions {
  readonly apiKey: string;
  /** Override for tests/proxies; defaults to {@link INCO_BASE_URL}. */
  readonly baseUrl?: string;
  /** Injected fetch for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build an {@link IncoClient} bound to a key and host. Pure construction: no
 * network happens until `chat` is called. Refuses an empty key so callers cannot
 * accidentally issue an unauthenticated request.
 */
export function createIncoClient(options: IncoClientOptions): IncoClient {
  if (options.apiKey.trim() === "") {
    throw new IncoError("Inco client requires a non-empty API key", {
      retryable: false,
      kind: "shape",
    });
  }
  const baseUrl = (options.baseUrl ?? INCO_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  async function attemptOnce(request: ChatRequest): Promise<ChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The key is only ever placed here; it is never logged.
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.responseFormat === "json"
            ? { response_format: { type: "json_object" } }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new IncoError(
          `inco chat failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
          { status: response.status, retryable: isRetryableStatus(response.status), kind: "http" },
        );
      }

      const body: unknown = await response.json().catch(() => null);
      const content = parseContent(body);
      if (content === null) {
        throw new IncoError("inco chat returned an unrecognized response shape", {
          status: response.status,
          retryable: false,
          kind: "shape",
        });
      }
      return {
        content,
        model: parseModel(body, request.model),
        usage: parseUsage((body as Record<string, unknown> | null)?.["usage"]),
        status: response.status,
      };
    } catch (error: unknown) {
      if (error instanceof IncoError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new IncoError(
        aborted
          ? `inco chat timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : `inco chat network error: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, kind: aborted ? "timeout" : "network" },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async chat(request: ChatRequest): Promise<ChatResult> {
      const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      let lastError: IncoError | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await attemptOnce(request);
        } catch (error: unknown) {
          const incoError =
            error instanceof IncoError
              ? error
              : new IncoError(String(error), { retryable: true, kind: "network" });
          lastError = incoError;
          if (!incoError.retryable || attempt === maxAttempts) throw incoError;
          await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
      throw lastError ?? new IncoError("inco chat failed", { retryable: false, kind: "shape" });
    },
  };
}
