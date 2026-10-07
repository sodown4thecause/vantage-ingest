// ---------------------------------------------------------------------------
// Queue message construction + size guarding (pure).
//
// Extracted from `src/index.ts` so both the `/signals` HTTP seam and the built-in
// scanner build `ingest-signal` messages through ONE code path. Keeping a single
// implementation means the byte-budget guarantee (below) holds for every
// producer, not just the HTTP one.
// ---------------------------------------------------------------------------
import type { QueueMessage, RawSignal } from "./types";

/**
 * Conservative message-size budget, below the 128 KB queue limit. Measured in
 * UTF-8 BYTES, not string length: Queues enforce a byte limit and non-ASCII
 * content (emoji, CJK, curly quotes) is 2–4x its UTF-16 code-unit count, so a
 * `.length` guard lets an oversized message through to a runtime rejection.
 */
export const MAX_MESSAGE_BYTES = 110 * 1024;

/** UTF-8 byte size of a message once serialized for the queue. */
export function messageBytes(message: QueueMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

/** Build one `ingest-signal` message for a source. */
export function signalMessage(
  sourceId: string,
  enqueuedAt: string,
  items: ReadonlyArray<RawSignal>,
): QueueMessage {
  return { kind: "ingest-signal", sourceId, enqueuedAt, items };
}

/**
 * Greedily chunk signals so each enqueued message stays under the byte budget.
 * A single signal too large to fit in one message is dropped (never enqueued
 * oversized) and reported via `droppedOversized` so the caller can count it.
 */
export function chunkSignals(
  sourceId: string,
  enqueuedAt: string,
  signals: ReadonlyArray<RawSignal>,
): { readonly messages: ReadonlyArray<QueueMessage>; readonly droppedOversized: number } {
  const messages: QueueMessage[] = [];
  let chunk: RawSignal[] = [];
  let droppedOversized = 0;
  for (const signal of signals) {
    if (messageBytes(signalMessage(sourceId, enqueuedAt, [signal])) > MAX_MESSAGE_BYTES) {
      droppedOversized += 1;
      console.error(
        JSON.stringify({
          event: "signals.dropped_oversized",
          sourceId,
          title: signal.title,
          url: signal.url,
          budgetBytes: MAX_MESSAGE_BYTES,
        }),
      );
      continue;
    }
    if (
      chunk.length > 0 &&
      messageBytes(signalMessage(sourceId, enqueuedAt, [...chunk, signal])) > MAX_MESSAGE_BYTES
    ) {
      messages.push(signalMessage(sourceId, enqueuedAt, chunk));
      chunk = [signal];
    } else {
      chunk = [...chunk, signal];
    }
  }
  if (chunk.length > 0) {
    messages.push(signalMessage(sourceId, enqueuedAt, chunk));
  }
  return { messages, droppedOversized };
}
