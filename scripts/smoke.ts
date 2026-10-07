// Smoke test for the pure boundary logic: registry expansion, URL canonical,
// title normalization, feed parsing, in-batch dedup, and signal filtering.
// No network / DB required.
// Run: npm run smoke   (uses tsx; resolves the extensionless ESM imports)
import { expandRegistry } from "../src/registry/index.ts";
import {
  canonicalizeUrl,
  normalizePercentEncoding,
  normalizeSignals,
  normalizeTitle,
  parseFeed,
} from "../src/normalizer.ts";
import { dedupeBatch } from "../src/db.ts";
import { MAX_MESSAGE_BYTES, chunkSignals, messageBytes } from "../src/index.ts";
import {
  parseClassificationResponse,
  chunkItems,
  reconcile,
  missingIndices,
  buildRepairPrompt,
  getClassifierConfig,
  classifyOneBatch,
  canonicalizeEntity,
  canonicalizeEntities,
  normalizeMention,
  clusterByGlobalTitleHash,
  currentClusterMemberIds,
  clusterLifecycle,
  shouldWriteClassification,
  shouldLoadForClassification,
  isValidRepairIndexSet,
  getScannerConfig,
  DEFAULT_SCANNER_MODEL,
  DEFAULT_TRACKED_ENTITIES,
  SCANNER_SOURCE_ID,
  parseScannerResponse,
  mapScannerSignal,
  scannerDedupKey,
  selectNewSignals,
  buildScannerPrompt,
  runScanner,
} from "../src/index.ts";
import type { IncoClient } from "../src/inco/client.ts";
import type { ClassificationItem } from "../src/classify/schema.ts";
import type { NormalizedItem, QueueMessage, RawSignal, Source, Env } from "../src/types.ts";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok:   ${label}`);
  }
}

/** Build a minimal trusted item for the pure `dedupeBatch` tests. */
function makeItem(overrides: Partial<NormalizedItem>): NormalizedItem {
  return {
    sourceId: "test-source",
    sourceName: "Test Source",
    category: "news",
    title: "Title",
    url: "https://example.com/a",
    author: null,
    publishedAt: null,
    summary: null,
    canonicalUrl: "https://example.com/a",
    titleHash: "title-hash",
    globalTitleHash: "global-title-hash",
    contentHash: "content-hash",
    rawContent: "",
    fetchedAt: "2026-10-01T00:00:00.000Z",
    signalTags: [],
    ...overrides,
  };
}

const sources = expandRegistry();
check("registry expands to > 20 sources", sources.length > 20);
check("all ids unique", new Set(sources.map((s) => s.id)).size === sources.length);
check(
  "google news templates expanded",
  sources.some((s) => s.id.startsWith("google-news:")),
);
check(
  "edgar carries descriptive-UA policy",
  sources.find((s) => s.id.startsWith("sec-edgar"))?.rateLimit?.requiresDescriptiveUserAgent === true,
);

check(
  "canonical url drops utm + trailing slash",
  canonicalizeUrl("https://Example.com/Path/?utm_source=x&b=2&a=1") ===
    "https://example.com/Path?a=1&b=2",
);
check(
  "title normalization is stable",
  normalizeTitle("Hello,   World! https://x.com") === "hello world",
);

// --- Fix 1: canonicalization gaps ------------------------------------------
check(
  "canonical: http vs https collapse",
  canonicalizeUrl("http://example.com/post") === canonicalizeUrl("https://example.com/post"),
);
check(
  "canonical: www vs bare collapse",
  canonicalizeUrl("https://www.example.com/post") === canonicalizeUrl("https://example.com/post"),
);
check(
  "canonical: trailing slash variants collapse",
  canonicalizeUrl("https://example.com/post/") === canonicalizeUrl("https://example.com/post"),
);
check(
  "canonical: percent-encoding variants collapse (UTF-8)",
  canonicalizeUrl("https://example.com/caf%C3%A9") ===
    canonicalizeUrl("https://example.com/caf\u00e9"),
);
check(
  "canonical: reserved path escapes (%2F) are preserved",
  canonicalizeUrl("https://example.com/a%2Fb") === "https://example.com/a%2Fb",
);
check(
  "canonical: the four feeds-of-one-article collapse to one url",
  new Set([
    canonicalizeUrl("http://www.example.com/post"),
    canonicalizeUrl("https://example.com/post/"),
    canonicalizeUrl("https://www.example.com/post/"),
    canonicalizeUrl("http://example.com/post"),
  ]).size === 1,
);

// --- C2: percent-encoding must never decode (no over-merge) -----------------
{
  // The percent-normalizer uppercases escape hex, and decodes NOTHING. That is
  // what keeps reserved/dot bytes from changing segmentation.
  check(
    "percent: uppercases hex case only",
    normalizePercentEncoding("/a%2fb%3fc%23d") === "/a%2Fb%3Fc%23d",
  );
  check(
    "percent: leaves non-escapes untouched",
    normalizePercentEncoding("/a%2E%2Eb/%252F/caf%C3%A9") === "/a%2E%2Eb/%252F/caf%C3%A9",
  );

  check(
    "canonical: %252F (literal %2F) does NOT collapse with %2F",
    canonicalizeUrl("https://h/x%252Fy") !== canonicalizeUrl("https://h/x%2Fy"),
  );
  check(
    "canonical: hex case variants DO collapse (%2f == %2F)",
    canonicalizeUrl("https://h/x%2fy") === canonicalizeUrl("https://h/x%2Fy"),
  );
  check(
    "canonical: %2F preserved, distinct from /",
    canonicalizeUrl("https://h/a%2Fb") !== canonicalizeUrl("https://h/a/b"),
  );
  check(
    "canonical: %3F preserved, distinct from ?",
    canonicalizeUrl("https://h/a%3Fb") !== canonicalizeUrl("https://h/a?b"),
  );
  check(
    "canonical: %23 preserved, distinct from #",
    canonicalizeUrl("https://h/a%23b") !== canonicalizeUrl("https://h/a#b"),
  );

  // `%2E%2E` / `%2E` are resolved by the WHATWG URL parser BEFORE our
  // normalization runs (the spec treats a `%2E` segment as a dot segment), so a
  // percent-encoded traversal and its literal counterpart deliberately denote the
  // same resource. The critical invariant our fix guarantees is that OUR stage
  // does not additionally decode them: the raw escapes survive normalization.
  check(
    "percent: %2E%2E is not decoded (parser handles dot segments)",
    normalizePercentEncoding("/a/%2E%2E/secret") === "/a/%2E%2E/secret",
  );

  // A percent-encoded path character stays distinct from its decoded sibling at
  // the canonical level, so genuinely different articles never collide.
  check(
    "canonical: %25 escape is not re-decoded into a path separator",
    canonicalizeUrl("https://h/a%252Fb%252Fc") === "https://h/a%252Fb%252Fc",
  );
}

// --- C1: /signals chunker measures UTF-8 bytes, not code units --------------
{
  const enc = new TextEncoder();
  const cjk = "\u65b0\u805e\u30cb\u30e5\u30fc\u30b9"; // 新聞ニュース: 7 code units, 21 UTF-8 bytes
  const emoji = "\u{1F680}\u{1F4A1}\u{1F9EA}"; // 🚀💡🧪: 5 code units, 12 UTF-8 bytes
  const fatSignal: RawSignal = {
    title: `${cjk} title`,
    url: "https://example.com/fat",
    rawContent: cjk.repeat(18_000),
  };

  // Sanity: this signal is under the budget by code-unit length but over it by
  // byte length — exactly the case a `.length` guard would wave through.
  const fatMessage: QueueMessage = {
    kind: "ingest-signal",
    sourceId: "s",
    enqueuedAt: "t",
    items: [fatSignal],
  };
  check(
    "chunker: fat signal is under budget by chars but over by bytes",
    JSON.stringify(fatMessage).length <= MAX_MESSAGE_BYTES &&
      messageBytes(fatMessage) > MAX_MESSAGE_BYTES,
  );

  // An emoji-heavy signal exercises the 2-code-unit/4-byte case too.
  const emojiSignal: RawSignal = {
    title: "emoji",
    url: "https://example.com/emoji",
    rawContent: emoji.repeat(9_000),
  };
  const emojiMessage: QueueMessage = {
    kind: "ingest-signal",
    sourceId: "s",
    enqueuedAt: "t",
    items: [emojiSignal],
  };
  check(
    "chunker: emoji signal is heavier in bytes than code units",
    messageBytes(emojiMessage) > JSON.stringify(emojiMessage).length,
  );

  const skinny: RawSignal = { title: "hello", url: "https://example.com/1" };
  const { messages, droppedOversized } = chunkSignals("s", "t", [skinny, fatSignal, skinny]);
  check("chunker: oversized single signal is dropped and counted", droppedOversized === 1);

  const emitted = messages.flatMap((m) => (m.kind === "ingest-signal" ? m.items : []));
  check(
    "chunker: survives (non-oversized) signals are preserved",
    emitted.length === 2 && emitted.every((s) => s.url === skinny.url),
  );

  // The core guarantee: EVERY emitted message serializes under the queue limit
  // in BYTES, even with multibyte content.
  check(
    "chunker: every emitted message is under the byte budget",
    messages.every((m) => messageBytes(m) <= MAX_MESSAGE_BYTES),
  );
  check(
    "chunker: every emitted message is under the real 128 KB queue limit",
    messages.every((m) => enc.encode(JSON.stringify(m)).byteLength < 128 * 1024),
  );

  // Many mid-size CJK signals pack into multiple byte-bounded messages.
  const midSignals: RawSignal[] = Array.from({ length: 20 }, (_, i) => ({
    title: `${cjk} ${i}`,
    url: `https://example.com/${i}`,
    rawContent: cjk.repeat(1_500),
  }));
  const packed = chunkSignals("s", "t", midSignals);
  check("chunker: packs many multibyte signals into >1 message", packed.messages.length > 1);
  check(
    "chunker: all packed messages respect the byte budget",
    packed.messages.every((m) => messageBytes(m) <= MAX_MESSAGE_BYTES),
  );
}

// --- Fix 4: tracking-param over-deletion -----------------------------------
check(
  "canonical: utm/fbclid/gclid stripped globally",
  canonicalizeUrl("https://example.com/p?utm_source=x&fbclid=y&gclid=z&keep=1") ===
    canonicalizeUrl("https://example.com/p?keep=1"),
);
check(
  "canonical: meaningful `source` is NOT collapsed",
  canonicalizeUrl("https://example.com/p?source=newsletter") !==
    canonicalizeUrl("https://example.com/p?source=homepage"),
);
check(
  "canonical: meaningful `ref` is NOT collapsed",
  canonicalizeUrl("https://example.com/p?ref=a") !== canonicalizeUrl("https://example.com/p?ref=b"),
);
check(
  "canonical: `source` stripped only when opted in per-source",
  canonicalizeUrl("https://example.com/p?source=x", new Set(["source"])) ===
    canonicalizeUrl("https://example.com/p"),
);

// --- Fix 2: intra-batch dedup ----------------------------------------------
{
  const identicalTitleDifferentUrl = dedupeBatch([
    makeItem({ canonicalUrl: "https://example.com/a", titleHash: "same" }),
    makeItem({ canonicalUrl: "https://example.com/b", titleHash: "same" }),
  ]);
  check("dedupeBatch: identical title collapses within a batch", identicalTitleDifferentUrl.length === 1);

  const identicalCanonicalUrl = dedupeBatch([
    makeItem({ canonicalUrl: "https://example.com/a", titleHash: "t1" }),
    makeItem({ canonicalUrl: "https://example.com/a", titleHash: "t2" }),
  ]);
  check("dedupeBatch: identical canonical url collapses within a batch", identicalCanonicalUrl.length === 1);

  const distinct = dedupeBatch([
    makeItem({ canonicalUrl: "https://example.com/a", titleHash: "t1" }),
    makeItem({ canonicalUrl: "https://example.com/b", titleHash: "t2" }),
  ]);
  check("dedupeBatch: distinct rows all survive", distinct.length === 2);

  const empty = dedupeBatch([]);
  check("dedupeBatch: empty input yields empty output", empty.length === 0);
}

// --- Fix 6: normalizeSignals filter parity ---------------------------------
{
  const source: Source = {
    id: "signals-test",
    name: "Signals Test",
    category: "news",
    accessMethod: "rss",
    url: "https://example.com/feed",
    pollIntervalMinutes: 20,
    signalType: "market-news",
    enabled: true,
  };
  const normalized = await normalizeSignals(
    source,
    [
      { title: "Good", url: "https://example.com/1" },
      { title: "   ", url: "https://example.com/2" },
      { title: "No url", url: "" },
      { title: "Also good", url: "https://example.com/4" },
    ],
    "2026-10-01T00:00:00.000Z",
  );
  check("normalizeSignals: drops empty title/url like normalize", normalized.length === 2);
  check(
    "normalizeSignals: computes unscoped globalTitleHash",
    normalized.every((i) => i.globalTitleHash.length === 64),
  );
}

const rss = `<?xml version="1.0"?><rss><channel>
  <item><title>First</title><link>https://example.com/a</link>
  <description>&lt;p&gt;Hello&lt;/p&gt;</description>
  <pubDate>Wed, 01 Oct 2026 12:00:00 GMT</pubDate><dc:creator>a</dc:creator></item>
</channel></rss>`;
const items = parseFeed(rss);
check("parses one rss item", items.length === 1);
check("strips html from summary", items[0]?.summary === "Hello");

const atom = `<?xml version="1.0"?><feed>
  <entry><title>Entry</title>
  <link rel="alternate" href="https://example.com/e"/>
  <published>2026-10-01T00:00:00Z</published></entry>
</feed>`;
check("parses atom entry", parseFeed(atom)[0]?.url === "https://example.com/e");

// ===========================================================================
// Signal layer (classification + entity resolution). Pure logic only — the
// mock `IncoClient` never touches the network and the real API key is never
// required.
// ===========================================================================

// --- JSON validation + repair path -----------------------------------------
{
  check(
    "schema: accepts a bare JSON array",
    parseClassificationResponse(
      '[{"index":0,"labels":["launch"],"relevance":0.9,"reason":"new tool"}]',
    ).ok === true,
  );
  check(
    "schema: accepts { items: [...] } wrapper",
    parseClassificationResponse(
      '{"items":[{"index":0,"labels":["noise"],"relevance":0.1,"reason":"spam"}]}',
    ).ok === true,
  );
  check(
    "schema: rejects malformed JSON",
    parseClassificationResponse("not json at all").ok === false,
  );
  check(
    "schema: rejects an unknown label",
    parseClassificationResponse(
      '[{"index":0,"labels":["malware"],"relevance":0.9,"reason":"x"}]',
    ).ok === false,
  );
  check(
    "schema: rejects out-of-range relevance",
    parseClassificationResponse(
      '[{"index":0,"labels":["launch"],"relevance":2.0,"reason":"x"}]',
    ).ok === false,
  );
  check(
    "schema: rejects empty label list",
    parseClassificationResponse('[{"index":0,"labels":[],"relevance":0.9,"reason":"x"}]').ok ===
      false,
  );
  check(
    "schema: strips ```json fences",
    parseClassificationResponse(
      '```json\n[{"index":0,"labels":["funding"],"relevance":0.5,"reason":"raise"}]\n```',
    ).ok === true,
  );

  // missingIndices + reconcile: missing index becomes a well-formed fallback.
  const batch = [
    { id: 1, sourceName: "s", title: "t1", summary: null, rawContent: "" },
    { id: 2, sourceName: "s", title: "t2", summary: null, rawContent: "" },
    { id: 3, sourceName: "s", title: "t3", summary: null, rawContent: "" },
  ];
  const partial = parseClassificationResponse(
    '[{"index":0,"labels":["launch"],"relevance":0.9,"reason":"a"},{"index":2,"labels":["chatter"],"relevance":0.3,"reason":"c"}]',
  );
  const parsedItems = partial.ok ? partial.items : [];
  check("repair: detects exactly the missing index", missingIndices(batch, parsedItems).join(",") === "1");

  const fixed = reconcile(batch, parsedItems);
  check("reconcile: unclassified fallback is well-formed", fixed[1]?.status === "unclassified");
  check("reconcile: fallback has empty labels + zero relevance", fixed[1]?.labels.length === 0 && fixed[1]?.relevance === 0);
  check("reconcile: classified rows retain their labels", fixed[0]?.labels[0] === "launch" && fixed[2]?.labels[0] === "chatter");

  const outOfRange: ReadonlyArray<ClassificationItem> = [
    { index: 99, labels: ["noise"], entities: [], relevance: 0.1, reason: "x", uncertain: [] },
  ];
  const outOfRangeResult = reconcile(batch, outOfRange);
  check("reconcile: out-of-range index cannot reach an item", outOfRangeResult.every((r) => r.status === "unclassified"));

  // Repair prompt only covers the missing indices.
  const repairPrompt = buildRepairPrompt(batch, [1]);
  check("repair prompt: excludes already-classified items", !repairPrompt.user.includes("t1") && !repairPrompt.user.includes("t3"));
  check("repair prompt: includes the missing item", repairPrompt.user.includes("t2"));
}

// --- Mock inco client: primary + repair, no network -------------------------
{
  const makeMockClient = (
    replies: ReadonlyArray<string>,
  ): { client: IncoClient; calls: () => number } => {
    let i = 0;
    return {
      client: {
        async chat() {
          const content = replies[Math.min(i, replies.length - 1)] as string;
          i += 1;
          return { content, model: "deepseek-v4.1-flash", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, status: 200 };
        },
      },
      calls: () => i,
    };
  };

  const batch = [
    { id: 10, sourceName: "s", title: "Launch of Foo", summary: "we shipped", rawContent: "" },
    { id: 11, sourceName: "s", title: "Foo is broken", summary: "bug", rawContent: "" },
  ];
  const config = getClassifierConfig({} as Env);

  // Primary misses index 1; repair supplies it.
  const mock = makeMockClient([
    '[{"index":0,"labels":["launch"],"relevance":0.9,"reason":"new"}]',
    '[{"index":0,"labels":["complaint"],"relevance":0.8,"reason":"bug"}]',
  ]);
  const results = await classifyOneBatch(mock.client, config, batch);
  check("mock: exactly two calls (primary + one repair)", mock.calls() === 2);
  check("mock: both items end classified", results.every((r) => r.status === "classified"));
  check("mock: repaired index maps to the right item id", results[1]?.id === 11 && results[1]?.labels[0] === "complaint");

  // Primary is malformed and repair is malformed too => unclassified fallback,
  // never a crash, exactly two calls (bounded repair).
  const brokenMock = makeMockClient(["garbage", "still garbage"]);
  const broken = await classifyOneBatch(brokenMock.client, config, batch);
  check("mock: bounded repair does not loop forever", brokenMock.calls() === 2);
  check("mock: unrecoverable batch falls back to unclassified", broken.every((r) => r.status === "unclassified"));

  // --- M3: misnumbered repair replies must never mislabel -------------------
  {
    // (a) Repair reply uses an ORIGINAL batch position (1) instead of the
    // renumbered ordinal (0). The missing list is just [1]; a reply at index 1
    // is out of range for missing.length===1, so the index set is invalid and the
    // whole repair is treated as a parse failure. The affected index (1) falls
    // back to `unclassified`; the primary result for index 0 is untouched and the
    // repair's `complaint` label never lands on the wrong row.
    const misnumbered = makeMockClient([
      '[{"index":0,"labels":["launch"],"relevance":0.9,"reason":"primary ok"}]',
      '[{"index":1,"labels":["complaint"],"relevance":0.8,"reason":"wrong ordinal"}]',
    ]);
    const misnumberedResults = await classifyOneBatch(misnumbered.client, config, batch);
    check(
      "M3: misnumbered repair leaves the missing index unclassified",
      misnumberedResults[1]?.status === "unclassified" && misnumberedResults[1]?.labels.length === 0,
    );
    check(
      "M3: misnumbered repair never writes its label to the wrong index",
      misnumberedResults[0]?.labels.join(",") === "launch" &&
        !misnumberedResults.some((r) => r.labels.includes("complaint")),
    );

    // (b) Duplicate ordinals. `missing` = [1]; index 0 reported twice is a
    // duplicate => invalid => the repair is discarded entirely, so the
    // `complaint`/`noise` labels it carried never reach any row.
    const duplicated = makeMockClient([
      '[{"index":0,"labels":["launch"],"relevance":0.9,"reason":"primary ok"}]',
      '[{"index":0,"labels":["complaint"],"relevance":0.8,"reason":"a"},{"index":0,"labels":["noise"],"relevance":0.1,"reason":"b"}]',
    ]);
    const duplicatedResults = await classifyOneBatch(duplicated.client, config, batch);
    check(
      "M3: duplicate-ordinal repair leaves the missing index unclassified",
      duplicatedResults[1]?.status === "unclassified",
    );
    check(
      "M3: duplicate-ordinal repair writes no repaired label anywhere",
      !duplicatedResults.some((r) => r.labels.includes("complaint") || r.labels.includes("noise")),
    );

    // Pure predicate truth table, independent of the handler.
    const oneMissing: ReadonlyArray<ClassificationItem> = [
      { index: 0, labels: ["launch"], entities: [], relevance: 0.9, reason: "x", uncertain: [] },
    ];
    check("M3: valid repair index set (subset 0..n-1) accepted", isValidRepairIndexSet(oneMissing, 1));
    check(
      "M3: repair index equal to original position rejected",
      !isValidRepairIndexSet(
        [{ index: 1, labels: ["launch"], entities: [], relevance: 0.9, reason: "x", uncertain: [] }],
        1,
      ),
    );
    check(
      "M3: duplicate repair ordinals rejected",
      !isValidRepairIndexSet(
        [
          { index: 0, labels: ["launch"], entities: [], relevance: 0.9, reason: "x", uncertain: [] },
          { index: 0, labels: ["noise"], entities: [], relevance: 0.1, reason: "y", uncertain: [] },
        ],
        2,
      ),
    );
    check(
      "M3: repair subset smaller than asked is accepted (partial reply)",
      isValidRepairIndexSet(oneMissing, 3),
    );
    check("M3: empty repair reply is accepted (nothing to remap)", isValidRepairIndexSet([], 3));
  }
}

// --- M1: version-keyed write guard (pure mirror of the SQL predicate) -------
{
  // (a) a null row (never classified) gets classified.
  check(
    "M1: null classified_at is always writable",
    shouldWriteClassification({ classifiedAt: null, version: null }, "v1"),
  );
  // (b) a row already at version V is NOT overwritten by a writer at version V.
  check(
    "M1: same-version writer is a no-op (first-writer-wins)",
    !shouldWriteClassification({ classifiedAt: "2026-10-01T00:00:00Z", version: "v1" }, "v1"),
  );
  // (c) a re-classify at a different version DOES overwrite.
  check(
    "M1: version bump overwrites",
    shouldWriteClassification({ classifiedAt: "2026-10-01T00:00:00Z", version: "v1" }, "v2"),
  );
  // A row that is stamped but has no stored version is writable (unknown prior).
  check(
    "M1: stamped row with null version is writable",
    shouldWriteClassification({ classifiedAt: "2026-10-01T00:00:00Z", version: null }, "v1"),
  );
}

// --- M1 (load side): version-stale rows ARE selected for re-classification ---
{
  // A never-classified row is always selected.
  check(
    "M1-load: null classified_at is selected",
    shouldLoadForClassification({ classifiedAt: null, version: null }, "v1"),
  );
  // A row already at the current version is NOT reloaded (no re-billing).
  check(
    "M1-load: same-version row is skipped (no re-bill)",
    !shouldLoadForClassification({ classifiedAt: "2026-10-01T00:00:00Z", version: "v1" }, "v1"),
  );
  // THE FIX: a version-stale row IS selected so a version bump triggers
  // re-classification (the policy the README documents).
  check(
    "M1-load: version-stale row is selected for re-classification",
    shouldLoadForClassification({ classifiedAt: "2026-10-01T00:00:00Z", version: "v1" }, "v2"),
  );
  // A stamped row with an unknown (null) stored version is selected.
  check(
    "M1-load: stamped row with null version is selected",
    shouldLoadForClassification({ classifiedAt: "2026-10-01T00:00:00Z", version: null }, "v1"),
  );

  // Convergence: once a stale row is re-written at the new version, the next
  // load no longer selects it — the stale set drains after one pass.
  const stale = { classifiedAt: "2026-10-01T00:00:00Z", version: "v1" };
  const rewritten = { classifiedAt: "2026-10-02T00:00:00Z", version: "v2" };
  check(
    "M1-load: stale row converges after one re-classify pass",
    shouldLoadForClassification(stale, "v2") && !shouldLoadForClassification(rewritten, "v2"),
  );
}

// --- Batch chunking ---------------------------------------------------------
{
  const items = Array.from({ length: 40 }, (_, i) => i);
  const batches = chunkItems(items, 15, 60);
  check("chunk: 40 items / 15 => 3 batches", batches.length === 3);
  check("chunk: first two batches full", batches[0]?.length === 15 && batches[1]?.length === 15);
  check("chunk: last batch is the remainder", batches[2]?.length === 10);
  check("chunk: flattens back to the original order", batches.flat().join(",") === items.join(","));

  const capped = chunkItems(items, 15, 25);
  check("chunk: respects the per-message cap", capped.flat().length === 25);
  check("chunk: empty input yields no batches", chunkItems([], 15, 60).length === 0);
  let threw = false;
  try {
    chunkItems([1], 0, 10);
  } catch {
    threw = true;
  }
  check("chunk: non-positive batch size fails loud", threw);
}

// --- Entity alias canonicalization -----------------------------------------
{
  check("alias: exact canonical name", canonicalizeEntity("Cursor") === "Cursor");
  check("alias: hyphen/space variants collapse", canonicalizeEntity("claude-code") === canonicalizeEntity("Claude Code"));
  check("alias: @handle resolves to the entity", canonicalizeEntity("@anthropic") === "Anthropic");
  check("alias: case-insensitive", canonicalizeEntity("OPENAI") === "OpenAI");
  check("alias: unknown mention self-canonicalizes (normalized)", canonicalizeEntity("Some New Tool") === "some new tool");
  check(
    "alias: list dedupes canonical names in order",
    canonicalizeEntities(["Claude Code", "claude-code", "@anthropic", "Cursor"]).join("|") ===
      "Anthropic Claude Code|Anthropic|Cursor",
  );
  check("alias: blank mention is dropped", canonicalizeEntities(["", "   "]).length === 0);
  check("mention: leading @ is stripped, punctuation removed", normalizeMention("@Anthropic, Inc.") === "anthropic inc");
}

// --- Cluster grouping (non-destructive multi-source echo) ------------------
{
  const rows = [
    { id: 1, sourceId: "google-news:ai", globalTitleHash: "H1" },
    { id: 2, sourceId: "vendor-blog", globalTitleHash: "H1" },
    { id: 3, sourceId: "hacker-news", globalTitleHash: "H1" },
    { id: 4, sourceId: "vendor-blog", globalTitleHash: "H2" }, // same source twice
    { id: 5, sourceId: "vendor-blog", globalTitleHash: "H2" },
    { id: 6, sourceId: "x", globalTitleHash: null }, // no hash => never clusters
  ];
  const hints = clusterByGlobalTitleHash(rows, { minDistinctSources: 2 });
  check("cluster: single-hash 3-source echo forms one cluster", hints.length === 1);
  check("cluster: cluster key is the shared hash", hints[0]?.key === "H1");
  check("cluster: anchor is the lowest id", hints[0]?.anchorId === 1);
  check("cluster: members are all ids ascending", hints[0]?.memberIds.join(",") === "1,2,3");
  check("cluster: distinct source list is sorted", hints[0]?.sourceIds.join(",") === "google-news:ai,hacker-news,vendor-blog");
  check("cluster: 3 distinct sources => 0.8 confidence", hints[0]?.confidence === 0.8);

  check(
    "cluster: SAME-source repeats never form a cluster (H2 excluded)",
    hints.every((h) => h.key !== "H2"),
  );
  check(
    "cluster: null hash is ignored",
    hints.every((h) => !h.memberIds.includes(6)),
  );

  // Deterministic + safe: two distinct hashes each with 2 sources => two clusters.
  const two = clusterByGlobalTitleHash(
    [
      { id: 7, sourceId: "a", globalTitleHash: "HA" },
      { id: 8, sourceId: "b", globalTitleHash: "HA" },
      { id: 9, sourceId: "a", globalTitleHash: "HB" },
      { id: 10, sourceId: "c", globalTitleHash: "HB" },
    ],
    { minDistinctSources: 2 },
  );
  check("cluster: distinct hashes stay separate", two.length === 2 && two.every((h) => h.memberIds.length === 2));
  check("cluster: output is stably ordered", two.map((h) => h.key).join(",") === "HA,HB");
  check("cluster: empty input yields no hints", clusterByGlobalTitleHash([]).length === 0);
}

// --- M2: cluster membership is non-sticky across a sliding window -----------
{
  // Yesterday's window: hash H1 spans two distinct sources => one cluster.
  const before = clusterByGlobalTitleHash(
    [
      { id: 100, sourceId: "google-news:ai", globalTitleHash: "H1" },
      { id: 101, sourceId: "vendor-blog", globalTitleHash: "H1" },
      { id: 102, sourceId: "hacker-news", globalTitleHash: "H1" },
    ],
    { minDistinctSources: 2 },
  );
  check("M2: cluster forms before the slide", before.length === 1);
  check("M2: members are stamped before the slide", currentClusterMemberIds(before).size === 3);

  // After the slide the 3 echo items have aged out; only ONE of the H1 items is
  // still in the window (single source) => no cluster is emitted.
  const after = clusterByGlobalTitleHash(
    [
      { id: 103, sourceId: "vendor-blog", globalTitleHash: "H1" }, // only one source left
      { id: 104, sourceId: "x", globalTitleHash: "H2" },
    ],
    { minDistinctSources: 2 },
  );
  check("M2: no cluster is emitted after the slide", after.length === 0);
  check(
    "M2: member set is empty so the caller clears stale stamps",
    currentClusterMemberIds(after).size === 0,
  );

  // Lifecycle: the previously-emitted key H1 is now deactivated; nothing active.
  const lifecycle = clusterLifecycle(
    before.map((h) => h.key),
    after,
  );
  check("M2: lifecycle deactivates the stopped cluster", lifecycle.deactivatedKeys.join(",") === "H1");
  check("M2: lifecycle reports no active clusters", lifecycle.activeKeys.length === 0);

  // Re-forming: H1 comes back with two sources => active again, not deactivated.
  const reformed = clusterByGlobalTitleHash(
    [
      { id: 200, sourceId: "google-news:ai", globalTitleHash: "H1" },
      { id: 201, sourceId: "vendor-blog", globalTitleHash: "H1" },
    ],
    { minDistinctSources: 2 },
  );
  const reactivated = clusterLifecycle(["H1"], reformed);
  check("M2: re-formed cluster is active again", reactivated.activeKeys.join(",") === "H1");
  check("M2: re-formed cluster is not deactivated", reactivated.deactivatedKeys.length === 0);

  // A cluster that keeps being emitted is neither deactivated nor cleared.
  const stable = clusterLifecycle(
    ["HA", "HB"],
    clusterByGlobalTitleHash(
      [
        { id: 1, sourceId: "a", globalTitleHash: "HA" },
        { id: 2, sourceId: "b", globalTitleHash: "HA" },
        { id: 3, sourceId: "a", globalTitleHash: "HB" },
        { id: 4, sourceId: "c", globalTitleHash: "HB" },
      ],
      { minDistinctSources: 2 },
    ),
  );
  check("M2: still-corroborated clusters stay active", stable.activeKeys.join(",") === "HA,HB");
  check("M2: stable clusters are not deactivated", stable.deactivatedKeys.length === 0);
}

// ===========================================================================
// Grok X scanner. Pure logic + a mocked, network-free `runScanner`.
// ===========================================================================

// --- Scanner config parsing (kill switch + placeholder model) --------------
{
  const off = getScannerConfig({} as Env);
  check("scanner: disabled by default", off.enabled === false);
  check("scanner: default model is the placeholder", off.model === DEFAULT_SCANNER_MODEL);
  check("scanner: placeholder is reported unconfigured", off.modelConfigured === false);
  check("scanner: default tracked entities are non-empty", off.trackedEntities.length > 0);
  check("scanner: default cap is positive", off.maxItemsPerScan > 0);

  const on = getScannerConfig({
    SCANNER_ENABLED: "TRUE",
    INCO_SCANNER_MODEL: "grok-x-scan-v1",
    SCANNER_TRACKED_ENTITIES: "Acme AI, , Foo",
    SCANNER_MAX_ITEMS_PER_SCAN: "7",
  } as Env);
  check("scanner: SCANNER_ENABLED=TRUE turns it on", on.enabled === true);
  check("scanner: a real model is reported configured", on.modelConfigured === true);
  check(
    "scanner: tracked entities parse + drop blanks",
    on.trackedEntities.join("|") === "Acme AI|Foo",
  );
  check("scanner: cap parsed", on.maxItemsPerScan === 7);

  const emptyCsv = getScannerConfig({ SCANNER_TRACKED_ENTITIES: "  ,  " } as Env);
  check(
    "scanner: empty entity CSV falls back to defaults",
    emptyCsv.trackedEntities.length === DEFAULT_TRACKED_ENTITIES.length,
  );

  const badCap = getScannerConfig({ SCANNER_MAX_ITEMS_PER_SCAN: "-3" } as Env);
  check("scanner: non-positive cap falls back to default", badCap.maxItemsPerScan > 0);
}

// --- Untrusted LLM output validation ---------------------------------------
{
  check(
    "scanner schema: accepts a bare JSON array",
    parseScannerResponse(
      '[{"title":"Cursor ships X","url":"https://x.com/a/status/1","author":"dev","summary":"new"}]',
    ).ok === true,
  );
  check(
    "scanner schema: accepts { signals: [...] } wrapper",
    parseScannerResponse('{"signals":[{"title":"Foo launch"}]}').ok === true,
  );
  check(
    "scanner schema: strips ```json fences",
    parseScannerResponse('```json\n[{"title":"Fenced"}]\n```').ok === true,
  );
  check("scanner schema: rejects malformed JSON", parseScannerResponse("not json").ok === false);
  check(
    "scanner schema: rejects a non-array/non-signals shape",
    parseScannerResponse('{"items":[{"title":"x"}]}').ok === false,
  );
  check(
    "scanner schema: rejects an empty title (drop rule)",
    parseScannerResponse('[{"title":"   "}]').ok === false,
  );
  check(
    "scanner schema: rejects a non-string title",
    parseScannerResponse('[{"title":42}]').ok === false,
  );
  check(
    "scanner schema: rejects a non-URL url",
    parseScannerResponse('[{"title":"ok","url":"not a url"}]').ok === false,
  );
  check("scanner schema: empty response is rejected", parseScannerResponse("  ").ok === false);

  // A reply that parses but is empty is a VALID empty result, not a failure.
  const empty = parseScannerResponse('{"signals":[]}');
  check("scanner schema: empty array is a valid empty result", empty.ok === true && empty.signals.length === 0);
}

// --- Signal mapping + stable dedup key -------------------------------------
{
  const mapped = mapScannerSignal({
    title: "Cursor launches a new agent",
    url: "https://x.com/cursor/status/1?utm_source=app",
    author: "@cursor",
    publishedAt: "2026-10-07T10:00:00Z",
    summary: "A new agent mode.",
    tags: ["Cursor", "cursor", " ", "AI agent"],
  });
  check("map: title/url preserved", mapped.signal.title === "Cursor launches a new agent" && mapped.signal.url !== "");
  check("map: author + publishedAt preserved", mapped.signal.author === "@cursor" && mapped.signal.publishedAt === "2026-10-07T10:00:00Z");
  check("map: summary preserved", mapped.signal.summary === "A new agent mode.");
  check("map: rawContent falls back to summary", mapped.signal.rawContent === "A new agent mode.");
  check("map: tags de-duped case-insensitively, blanks dropped", mapped.signal.signalTags?.length === 2);
  check("map: dedupKey uses canonical url", mapped.dedupKey.startsWith("url:"));

  // Tracking params are stripped, so two permalink variants share ONE key.
  check(
    "map: dedupKey collapses utm variants",
    scannerDedupKey({ title: "a", url: "https://x.com/a/1?utm_source=x" }) ===
      scannerDedupKey({ title: "b", url: "https://x.com/a/1" }),
  );
  // URL-less signals fall back to a normalized-title key.
  const noUrl = mapScannerSignal({ title: "Foo!!   Launch" });
  check("map: URL-less signal keys on normalized title", noUrl.dedupKey === "title:foo launch");
  check("map: URL-less rawContent falls back to title", noUrl.signal.rawContent === "Foo!!   Launch");
  check(
    "map: different titles produce different keys",
    scannerDedupKey({ title: "one" }) !== scannerDedupKey({ title: "two" }),
  );
}

// --- Per-scan cap + dedup (selectNewSignals) -------------------------------
{
  const signals = [
    { title: "A", url: "https://x.com/a" },
    { title: "B", url: "https://x.com/b" },
    { title: "A again", url: "https://x.com/a" }, // duplicate url within batch
    { title: "C", url: "https://x.com/c" },
    { title: "D", url: "https://x.com/d" },
  ];
  const sel = selectNewSignals(signals, new Set(), 3);
  check("select: in-batch duplicate dropped", sel.mapped.length === 3);
  check("select: cap respected", sel.mapped.map((m) => m.signal.title).join(",") === "A,B,C");
  check("select: skipped accounts for dup + over-cap", sel.skipped === 2);

  const seen = new Set(["url:https://x.com/a"]);
  const deduped = selectNewSignals(signals, seen, 10);
  check("select: seen-key suppresses a repeat across scans", !deduped.mapped.some((m) => m.signal.title === "A"));

  check("select: empty input yields nothing", selectNewSignals([], new Set(), 10).mapped.length === 0);
}

// --- Prompt builds with tracked entities -----------------------------------
{
  const config = getScannerConfig({ INCO_SCANNER_MODEL: "grok-x-scan-v1" } as Env);
  const prompt = buildScannerPrompt(config);
  check("prompt: user turn lists tracked entities", prompt.user.includes("Cursor"));
  check("prompt: system turn states the JSON contract", prompt.system.includes("signals"));
  check("prompt: cap is echoed in the user turn", prompt.user.includes(String(config.maxItemsPerScan)));
}

// --- runScanner with a mock client (no network, no real key) ---------------
{
  const baseEnv = {
    SCANNER_ENABLED: "true",
    INCO_SCANNER_MODEL: "grok-x-scan-v1",
    INCO_API_KEY: "test-key-not-real",
  } as unknown as Env;

  const makeClient = (reply: string): { client: IncoClient; calls: () => number } => {
    let n = 0;
    return {
      client: {
        async chat() {
          n += 1;
          return {
            content: reply,
            model: "grok-x-scan-v1",
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            status: 200,
          };
        },
      },
      calls: () => n,
    };
  };

  // (a) Disabled => no client call at all.
  {
    const mock = makeClient("[]");
    const enqueued: unknown[] = [];
    const outcome = await runScanner({ SCANNER_ENABLED: "false" } as Env, {
      makeClient: () => mock.client,
      enqueue: async (_e, msgs) => { enqueued.push(...msgs); },
    });
    check("runner: disabled => skipped-disabled", outcome.status === "skipped-disabled");
    check("runner: disabled => no LLM call", mock.calls() === 0);
    check("runner: disabled => nothing enqueued", enqueued.length === 0);
  }

  // (b) Enabled but model still the placeholder => skip without a call.
  {
    const mock = makeClient("[]");
    const outcome = await runScanner({ SCANNER_ENABLED: "true", INCO_API_KEY: "k" } as Env, {
      makeClient: () => mock.client,
    });
    check("runner: placeholder model => skipped-unconfigured", outcome.status === "skipped-unconfigured");
    check("runner: placeholder model => no LLM call", mock.calls() === 0);
  }

  // (c) Enabled + configured, happy path: validates, maps, enqueues, persists.
  {
    const mock = makeClient(
      '[{"title":"Cursor ships agent mode","url":"https://x.com/cursor/status/9","summary":"new feature","tags":["Cursor"]}]',
    );
    const enqueued: QueueMessage[] = [];
    let saved: ReadonlyArray<string> | null = null;
    const outcome = await runScanner(baseEnv, {
      makeClient: () => mock.client,
      loadSeen: async () => new Set(),
      saveSeen: async (_e, keys) => { saved = keys; },
      enqueue: async (_e, msgs) => { enqueued.push(...msgs); },
    });
    check("runner: happy path status scanned", outcome.status === "scanned");
    check("runner: one LLM call", mock.calls() === 1);
    check("runner: scanned count is 1", outcome.scanned === 1);
    check("runner: enqueued count is 1", outcome.enqueued === 1);
    check("runner: exactly one ingest-signal message", enqueued.length === 1 && enqueued[0]?.kind === "ingest-signal");
    check(
      "runner: message targets the scanner source",
      enqueued[0]?.kind === "ingest-signal" && enqueued[0].sourceId === SCANNER_SOURCE_ID,
    );
    check("runner: seen keys persisted (non-null)", saved !== null && (saved as ReadonlyArray<string>).length === 1);
  }

  // (d) Parse failure => error, nothing enqueued.
  {
    const mock = makeClient("definitely not json");
    const enqueued: unknown[] = [];
    const outcome = await runScanner(baseEnv, {
      makeClient: () => mock.client,
      loadSeen: async () => new Set(),
      saveSeen: async () => {},
      enqueue: async (_e, msgs) => { enqueued.push(...msgs); },
    });
    check("runner: unparseable output => error", outcome.status === "error");
    check("runner: unparseable output => nothing enqueued", enqueued.length === 0);
  }

  // (e) Duplicate of a previously-seen key => empty, nothing enqueued.
  {
    const mock = makeClient('[{"title":"Repeat","url":"https://x.com/repeat/1"}]');
    const enqueued: unknown[] = [];
    const seenKey = scannerDedupKey({ title: "Repeat", url: "https://x.com/repeat/1" });
    const outcome = await runScanner(baseEnv, {
      makeClient: () => mock.client,
      loadSeen: async () => new Set([seenKey]),
      saveSeen: async () => {},
      enqueue: async (_e, msgs) => { enqueued.push(...msgs); },
    });
    check("runner: duplicate-of-seen => empty", outcome.status === "empty");
    check("runner: duplicate-of-seen => nothing enqueued", enqueued.length === 0);
  }

  // (f) Client throws => error, never propagates.
  {
    const outcome = await runScanner(baseEnv, {
      makeClient: () => ({ chat: async () => { throw new Error("network down"); } }),
      loadSeen: async () => new Set(),
      saveSeen: async () => {},
      enqueue: async () => {},
    });
    check("runner: client fault is swallowed as error", outcome.status === "error");
  }

  // (g) Registry guard: if the scanner source is missing, refuse to enqueue.
  //     (Verified indirectly: the seeded registry DOES contain it, so a real
  //     scan proceeds — see the happy-path case above.)
  check(
    "registry: scanner source is seeded (so /signals accepts it)",
    sources.some((s) => s.id === SCANNER_SOURCE_ID),
  );
  check(
    "registry: scanner source is not polled (enabled false)",
    sources.find((s) => s.id === SCANNER_SOURCE_ID)?.enabled === false,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
