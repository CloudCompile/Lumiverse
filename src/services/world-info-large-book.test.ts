/**
 * Portable regression coverage for world-info activation and merge behavior.
 * Vector retrieval is represented with synthetic candidates so the suite has
 * no external data dependency.
 */
import { describe, test, expect } from "bun:test";

import type { WorldBookEntry } from "../types/world-book";
import type { Message } from "../types/message";
import {
  mergeActivatedWorldInfoEntries,
  type VectorActivatedEntry,
} from "./prompt-assembly.service";
import {
  activateWorldInfo,
  clearWorldInfoActivationCache,
  finalizeActivatedWorldInfoEntries,
  normalizeWorldInfoSettings,
  type WorldInfoSettings,
} from "./world-info-activation.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let __counter = 0;
function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  __counter++;
  // Each entry gets unique filler content so the content-level deduplicator
  // (which collapses near-duplicates) doesn't mask behaviour we want to
  // observe.
  const filler = `entry-${__counter} — ${"abcdefghij".repeat(__counter % 7 + 3)} ${__counter * 7919}`;
  return {
    id: overrides.id ?? crypto.randomUUID(),
    world_book_id: "book-a",
    uid: overrides.uid ?? crypto.randomUUID(),
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [],
    keysecondary: [],
    content: filler,
    comment: "",
    position: 0,
    depth: 4,
    role: null,
    order_value: 100,
    selective: true,
    constant: false,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 100,
    probability: 100,
    scan_depth: null,
    exclude_greeting: false,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: true,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 10,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: true,
    vectorized: true,
    vector_index_status: "indexed",
    vector_indexed_at: 0,
    vector_index_error: null,
    extensions: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
    revision: overrides.revision ?? 1,
  };
}

function makeMessage(content: string): Message {
  return {
    id: crypto.randomUUID(),
    chat_id: "chat-a",
    index_in_chat: 0,
    is_user: true,
    name: "User",
    content,
    send_date: 0,
    swipe_id: 0,
    swipes: [content],
    swipe_dates: [0],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  };
}

/** Wrap a WorldBookEntry as a VectorActivatedEntry with representative scoring. */
function asVectorCandidate(entry: WorldBookEntry, finalScore = 0.8): VectorActivatedEntry {
  return {
    entry,
    score: finalScore,
    distance: Number.POSITIVE_INFINITY,
    finalScore,
    lexicalCandidateScore: 10,
    matchedPrimaryKeys: [],
    matchedSecondaryKeys: [],
    matchedComment: null,
    scoreBreakdown: {
      vectorSimilarity: 0,
      lexicalContentBoost: finalScore,
      primaryExact: 0,
      primaryPartial: 0,
      secondaryExact: 0,
      secondaryPartial: 0,
      commentExact: 0,
      commentPartial: 0,
      focusBoost: 0,
      supportingContextBoost: 0,
      priority: 0,
      broadPenalty: 0,
      focusMissPenalty: 0,
    },
    searchTextPreview: entry.content.slice(0, 120),
  };
}

describe("world info RNG injection", () => {
  test("probability rolls use the injected random source", () => {
    const prefix = crypto.randomUUID();
    const accepted = makeEntry({
      id: `${prefix}-accepted`,
      uid: `${prefix}-accepted`,
      key: ["needle"],
      content: "accepted",
      selective: false,
      vectorized: false,
      probability: 50,
    });
    const rejected = makeEntry({
      id: `${prefix}-rejected`,
      uid: `${prefix}-rejected`,
      key: ["needle"],
      content: "rejected",
      selective: false,
      vectorized: false,
      probability: 50,
    });
    const rolls = [0.25, 0.75];
    let rollIndex = 0;

    const result = activateWorldInfo({
      entries: [accepted, rejected],
      messages: [makeMessage("needle")],
      chatTurn: 1,
      wiState: {},
      random: () => rolls[rollIndex++],
    });

    expect(rollIndex).toBe(2);
    expect(result.activatedEntries.map((entry) => entry.id)).toEqual([
      accepted.id,
    ]);
  });

  test("injected activation neither advances global RNG nor pollutes its result cache", () => {
    const prefix = crypto.randomUUID();
    const probabilistic = makeEntry({
      id: `${prefix}-entry`,
      uid: `${prefix}-entry`,
      key: ["needle"],
      content: "cache isolation",
      selective: false,
      vectorized: false,
      probability: 50,
    });
    const activationMessages = [makeMessage("needle")];
    const originalRandom = Math.random;
    let globalRolls = 0;

    Math.random = () => {
      globalRolls++;
      return 0.75;
    };
    try {
      const injected = activateWorldInfo({
        entries: [probabilistic],
        messages: activationMessages,
        chatTurn: 1,
        wiState: {},
        random: () => 0.25,
      });
      expect(injected.activatedEntries.map((entry) => entry.id)).toEqual([
        probabilistic.id,
      ]);
      expect(globalRolls).toBe(0);

      const ordinary = activateWorldInfo({
        entries: [probabilistic],
        messages: activationMessages,
        chatTurn: 1,
        wiState: {},
      });
      expect(ordinary.activatedEntries).toEqual([]);
      expect(globalRolls).toBe(1);

      const cachedOrdinary = activateWorldInfo({
        entries: [probabilistic],
        messages: activationMessages,
        chatTurn: 1,
        wiState: {},
      });
      expect(cachedOrdinary.activatedEntries).toEqual([]);
      expect(globalRolls).toBe(1);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("raw activation and merge do not advance global RNG when given an isolated source", () => {
    const prefix = crypto.randomUUID();
    const keyword = makeEntry({
      id: `${prefix}-keyword`,
      uid: `${prefix}-keyword`,
      key: ["needle"],
      content: "amber",
      selective: false,
      vectorized: false,
      probability: 50,
      group_name: `${prefix}-group`,
      group_weight: 1,
    });
    const vector = makeEntry({
      id: `${prefix}-vector`,
      uid: `${prefix}-vector`,
      content: "zephyr",
      group_name: `${prefix}-group`,
      group_weight: 1,
    });
    const activationMessages = [makeMessage("needle")];
    const originalRandom = Math.random;
    const globalValues = [0.25, 0.75, 0.42];
    let globalRolls = 0;

    Math.random = () => globalValues[globalRolls++];
    try {
      const nativeActivation = activateWorldInfo({
        entries: [keyword],
        messages: activationMessages,
        chatTurn: 1,
        wiState: {},
      });
      const nativeMerge = mergeActivatedWorldInfoEntries(
        nativeActivation.activatedEntries,
        [asVectorCandidate(vector)],
      );
      expect(globalRolls).toBe(2);

      const isolatedValues = [0.25, 0.75];
      let isolatedRolls = 0;
      const isolatedRandom = () => isolatedValues[isolatedRolls++];
      const rawActivation = activateWorldInfo({
        entries: [keyword],
        messages: activationMessages,
        chatTurn: 1,
        wiState: {},
        random: isolatedRandom,
      });
      const rawMerge = mergeActivatedWorldInfoEntries(
        rawActivation.activatedEntries,
        [asVectorCandidate(vector)],
        undefined,
        undefined,
        undefined,
        isolatedRandom,
      );

      expect(isolatedRolls).toBe(2);
      expect(globalRolls).toBe(2);
      expect(rawMerge.activatedEntries.map((entry) => entry.id)).toEqual(
        nativeMerge.activatedEntries.map((entry) => entry.id),
      );
      expect(Math.random()).toBe(0.42);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("world info activation cache pressure release", () => {
  test("drops cached probability results so the next activation recomputes", () => {
    const originalRandom = Math.random;
    const entry = makeEntry({ key: ["alpha"], probability: 50 });
    const input = {
      entries: [entry],
      messages: [makeMessage("alpha")],
      chatTurn: 1,
      settings: {},
    };

    try {
      clearWorldInfoActivationCache();
      Math.random = () => 0;
      expect(activateWorldInfo({ ...input, wiState: {} }).activatedEntries).toHaveLength(1);

      Math.random = () => 0.99;
      expect(activateWorldInfo({ ...input, wiState: {} }).activatedEntries).toHaveLength(1);

      clearWorldInfoActivationCache();
      expect(activateWorldInfo({ ...input, wiState: {} }).activatedEntries).toHaveLength(0);
    } finally {
      Math.random = originalRandom;
      clearWorldInfoActivationCache();
    }
  });
});

describe("finalizeActivatedWorldInfoEntries", () => {
  test("drops whitespace-only world info entries from activation and cache", () => {
    const result = finalizeActivatedWorldInfoEntries([
      makeEntry({ id: "blank", uid: "blank", content: "   \n\t  " }),
      makeEntry({ id: "real", uid: "real", content: "Useful lore" }),
    ]);

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual(["real"]);
    expect(result.cache.before).toEqual([{ role: "system", content: "Useful lore", entryLabel: "(unnamed entry real)" }]);
  });
});

describe("activateWorldInfo recursion settings", () => {
  test("activation cache invalidates on same-length keyword and message content changes", () => {
    const entryId = crypto.randomUUID();
    const uid = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const first = makeEntry({
      id: entryId,
      uid,
      key: ["alpha"],
      content: "first",
      vectorized: false,
    });
    const second = makeEntry({
      id: entryId,
      uid,
      key: ["bravo"],
      content: "reply",
      vectorized: false,
    });

    const firstResult = activateWorldInfo({
      entries: [first],
      messages: [{ ...makeMessage("alpha"), id: messageId }],
      chatTurn: 1,
      wiState: {},
      settings: {},
    });
    expect(firstResult.activatedEntries.map((entry) => entry.content)).toEqual(["first"]);

    const secondResult = activateWorldInfo({
      entries: [second],
      messages: [{ ...makeMessage("bravo"), id: messageId }],
      chatTurn: 1,
      wiState: {},
      settings: {},
    });
    expect(secondResult.activatedEntries.map((entry) => entry.content)).toEqual(["reply"]);
  });

  test("maxRecursionPasses=0 only performs the base keyword scan", () => {
    const first = makeEntry({
      key: ["alpha"],
      content: "recursive beta content",
      prevent_recursion: false,
      vectorized: false,
    });
    const second = makeEntry({ key: ["beta"], content: "second entry", vectorized: false });

    const result = activateWorldInfo({
      entries: [first, second],
      messages: [makeMessage("alpha")],
      chatTurn: 1,
      wiState: {},
      settings: { maxRecursionPasses: 0 },
    });

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual([first.id]);
    expect(result.stats.recursionPassesUsed).toBe(0);
  });

  test("recursive content consumes one configured recursion pass", () => {
    const first = makeEntry({
      key: ["alpha"],
      content: "recursive beta content",
      prevent_recursion: false,
      vectorized: false,
    });
    const second = makeEntry({ key: ["beta"], content: "second entry", vectorized: false });

    const result = activateWorldInfo({
      entries: [first, second],
      messages: [makeMessage("alpha")],
      chatTurn: 1,
      wiState: {},
      settings: { maxRecursionPasses: 1 },
    });

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(result.stats.recursionPassesUsed).toBe(1);
  });

  test("vectorized entries do not feed recursive keyword chaining", () => {
    const first = makeEntry({
      key: ["alpha"],
      content: "recursive beta content",
      prevent_recursion: false,
      vectorized: true,
      vector_index_status: "indexed",
    });
    const second = makeEntry({ key: ["beta"], content: "second entry", vectorized: false });

    const result = activateWorldInfo({
      entries: [first, second],
      messages: [makeMessage("alpha")],
      chatTurn: 1,
      wiState: {},
      settings: { maxRecursionPasses: 1 },
    });

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual([first.id]);
    expect(result.stats.recursionPassesUsed).toBe(0);
  });

  test("vectorized entries are not activated by recursive keyword chaining", () => {
    const first = makeEntry({
      key: ["alpha"],
      content: "recursive beta content",
      prevent_recursion: false,
      vectorized: false,
    });
    const second = makeEntry({
      key: ["beta"],
      content: "second entry",
      vectorized: true,
      vector_index_status: "indexed",
    });

    const result = activateWorldInfo({
      entries: [first, second],
      messages: [makeMessage("alpha")],
      chatTurn: 1,
      wiState: {},
      settings: { maxRecursionPasses: 1 },
    });

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual([first.id]);
    expect(result.stats.recursionPassesUsed).toBe(0);
  });

  test("constant content does not recursively activate entries when recursion is disabled", () => {
    const constant = makeEntry({
      key: [],
      constant: true,
      content: "constant beta content",
      prevent_recursion: false,
      vectorized: false,
    });
    const conditional = makeEntry({ key: ["beta"], content: "conditional entry", vectorized: false });

    const result = activateWorldInfo({
      entries: [constant, conditional],
      messages: [makeMessage("no matching keywords")],
      chatTurn: 1,
      wiState: {},
      settings: { maxRecursionPasses: 0 },
    });

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual([constant.id]);
    expect(result.stats.recursionPassesUsed).toBe(0);
  });
});

describe("normalizeWorldInfoSettings", () => {
  test("normalizes invalid and zero-valued world info settings", () => {
    expect(normalizeWorldInfoSettings({
      forceCaseSensitive: true,
      forceMatchWholeWords: true,
      globalScanDepth: 0,
      maxRecursionPasses: -1,
      maxActivatedEntries: -5,
      maxTokenBudget: -100,
      minPriority: -2,
    })).toEqual({
      forceCaseSensitive: true,
      forceMatchWholeWords: true,
      globalScanDepth: null,
      maxRecursionPasses: 0,
      maxActivatedEntries: 0,
      maxTokenBudget: 0,
      minPriority: 0,
    });
  });

  test("defaults global keyword matching overrides to off", () => {
    expect(normalizeWorldInfoSettings({})).toMatchObject({
      forceCaseSensitive: false,
      forceMatchWholeWords: false,
    });
  });
});

describe("global keyword matching overrides", () => {
  test("forces case-sensitive matching without changing the entry", () => {
    const entry = makeEntry({ key: ["Thornfield"], selective: false, vectorized: false });
    const result = activateWorldInfo({
      entries: [entry],
      messages: [makeMessage("thornfield")],
      chatTurn: 1,
      wiState: {},
      settings: { forceCaseSensitive: true },
    });

    expect(result.activatedEntries).toHaveLength(0);
    expect(entry.case_sensitive).toBe(false);
  });

  test("forces whole-word matching without changing the entry", () => {
    const entry = makeEntry({ key: ["fire"], selective: false, vectorized: false });
    const result = activateWorldInfo({
      entries: [entry],
      messages: [makeMessage("firehouse")],
      chatTurn: 1,
      wiState: {},
      settings: { forceMatchWholeWords: true },
    });

    expect(result.activatedEntries).toHaveLength(0);
    expect(entry.match_whole_words).toBe(false);
  });

  test("keeps per-entry matching options when global overrides are off", () => {
    const entry = makeEntry({
      key: ["Thornfield"],
      selective: false,
      vectorized: false,
      case_sensitive: true,
      match_whole_words: true,
    });
    const result = activateWorldInfo({
      entries: [entry],
      messages: [makeMessage("thornfields")],
      chatTurn: 1,
      wiState: {},
      settings: {},
    });

    expect(result.activatedEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Vector and keyword competition with default and configured limits.
// ---------------------------------------------------------------------------

describe("mergeActivatedWorldInfoEntries — vector and keyword competition", () => {
  test("includes the source book name in activated entry summaries", () => {
    const entry = makeEntry({ world_book_id: "book-lore" });

    const result = mergeActivatedWorldInfoEntries(
      [entry],
      [],
      {},
      new Map([["book-lore", "character"]]),
      new Map([["book-lore", "Character Lore"]]),
    );

    expect(result.activatedWorldInfo).toEqual([
      expect.objectContaining({ id: entry.id, bookName: "Character Lore" }),
    ]);
  });

  test("accepts all 15 vector candidates when settings are default", () => {
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: i + 1, comment: `memory #${i + 1}` })),
    );

    const result = mergeActivatedWorldInfoEntries(
      /* keyword */ [],
      /* vector  */ vectorCandidates,
      /* settings */ {},
    );

    expect(result.keywordActivated).toBe(0);
    expect(result.vectorActivated).toBe(15);
    expect(result.activatedEntries).toHaveLength(15);
  });

  test("accepts all 15 vector candidates when maxActivatedEntries >= 15", () => {
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: i + 1 })),
    );

    for (const cap of [15, 20, 100]) {
      const settings: Partial<WorldInfoSettings> = { maxActivatedEntries: cap };
      const result = mergeActivatedWorldInfoEntries([], vectorCandidates, settings);
      expect(result.vectorActivated).toBe(15);
    }
  });

  test("FIXED: score-boosted vectors can now displace equal-priority keyword entries at a full cap", () => {
    // Meaningful vector scores can beat equal-priority keyword entries while
    // the configured entry cap remains in force.
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ world_book_id: "other-book", key: ["x"], order_value: i + 1, comment: `kw-${i}` }),
    );
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, comment: `v-${i}` }), 0.8),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    // At least some vectors must activate.
    expect(result.vectorActivated).toBeGreaterThan(0);
    expect(result.totalActivated).toBe(15);
    // The output must still respect the configured cap.
    expect(result.activatedEntries.length).toBe(15);
  });

  test("FIXED: low-score vectors (finalScore ≈ 0) do NOT displace keyword entries", () => {
    // Marginal vector hits should not evict keyword matches — the boost is
    // bounded and proportional to finalScore, so near-zero scores contribute
    // near-zero boost.
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ world_book_id: "other-book", key: ["x"], order_value: i + 1, comment: `kw-${i}` }),
    );
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, comment: `v-${i}` }), 0.01),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    expect(result.keywordActivated).toBe(15);
    expect(result.vectorActivated).toBe(0);
  });

  test("FIXED: higher-priority keyword entries are still protected from vector displacement", () => {
    // Boost ceiling is 20 priority points, so a keyword entry with priority
    // ≥ 30 can never be displaced by a vector with base priority 10.
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ world_book_id: "other-book", key: ["x"], order_value: i + 1, priority: 50 }),
    );
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(
        makeEntry({ order_value: 1000 + i, priority: 10 }),
        /* saturated score */ 3.0,
      ),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    expect(result.keywordActivated).toBe(15);
    expect(result.vectorActivated).toBe(0);
  });

  test("token budget can also starve vectors — but skip counter is budgetSim, not budgetCap", () => {
    // Each entry is ~275 tokens; tokenBudget=100 means none survive.
    const vectorCandidates = Array.from({ length: 15 }, () =>
      asVectorCandidate(makeEntry({ content: "x".repeat(1100) })),
    );

    const result = mergeActivatedWorldInfoEntries([], vectorCandidates, {
      maxTokenBudget: 100,
    });

    // Token limits and entry-count limits report separate outcomes.
    expect(result.vectorActivated).toBe(0);
  });
});

describe("prompt-local world-info selection content", () => {
  test("filters a raw constant whose selection view is empty without caching the empty result", () => {
    const entry = makeEntry({
      id: crypto.randomUUID(),
      uid: crypto.randomUUID(),
      constant: true,
      content: "{{runtime condition}}large hidden payload{{/runtime condition}}",
      vectorized: false,
    });

    const hidden = activateWorldInfo({
      entries: [entry],
      messages: [],
      chatTurn: 0,
      wiState: {},
      settings: {},
      selectionContentByEntryId: new Map([[entry.id, ""]]),
    });
    const visible = activateWorldInfo({
      entries: [entry],
      messages: [],
      chatTurn: 0,
      wiState: {},
      settings: {},
      selectionContentByEntryId: new Map([[entry.id, "visible"]]),
    });

    expect(hidden.activatedEntries).toEqual([]);
    expect(visible.activatedEntries).toEqual([entry]);
  });

  test("uses selection content for budget and dedup while returning raw content", () => {
    const first = makeEntry({
      content: "A".repeat(4_000),
      priority: 20,
      vectorized: false,
    });
    const duplicate = makeEntry({
      content: "B".repeat(4_000),
      priority: 10,
      vectorized: false,
    });
    const selectionContentByEntryId = new Map([
      [first.id, "same"],
      [duplicate.id, "same"],
    ]);

    const result = mergeActivatedWorldInfoEntries(
      [first, duplicate],
      [],
      { maxTokenBudget: 1 },
      undefined,
      undefined,
      undefined,
      selectionContentByEntryId,
    );

    expect(result.activatedEntries).toEqual([first]);
    expect(result.activatedEntries[0]?.content).toBe(first.content);
    expect(result.cache.before[0]?.content).toBe(first.content);
    expect(result.estimatedTokens).toBe(1);
    expect(result.deduplicated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: equal priority + high order_value loses even when budget has room
// ---------------------------------------------------------------------------

describe("mergeActivatedWorldInfoEntries — priority/order tie-breaking", () => {
  test("higher-priority vector entries displace lower-priority keyword entries", () => {
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ key: ["x"], order_value: i + 1, priority: 5 }),
    );
    const vectorCandidates = Array.from({ length: 5 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, priority: 50 })),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    // With priority inversion, vectors should make it in.
    expect(result.vectorActivated).toBeGreaterThan(0);
  });

  test("when budget has headroom, vector entries always win — even at equal priority", () => {
    const keywordEntries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ key: ["x"], order_value: i + 1, priority: 10 }),
    );
    const vectorCandidates = Array.from({ length: 10 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, priority: 10 })),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 20 },
    );

    expect(result.keywordActivated).toBe(5);
    expect(result.vectorActivated).toBe(10);
  });
});

describe("mergeActivatedWorldInfoEntries — unified finalization", () => {
  test("content deduplication cannot undo a score-boosted vector winner", () => {
    const keywordA = makeEntry({ id: "keyword-a", order_value: 1, content: "keyword a" });
    const keywordB = makeEntry({ id: "keyword-b", order_value: 2, content: "duplicate lore" });
    const keywordDuplicate = makeEntry({ id: "keyword-dupe", order_value: 3, content: "duplicate lore" });
    const vector = makeEntry({ id: "vector-winner", order_value: 1000, content: "vector lore", priority: 10 });

    const result = mergeActivatedWorldInfoEntries(
      [keywordA, keywordB, keywordDuplicate],
      [asVectorCandidate(vector, 1)],
      { maxActivatedEntries: 2 },
    );

    expect(result.deduplicated).toBe(1);
    expect(result.activatedEntries.map((entry) => entry.id)).toContain("vector-winner");
    expect(result.vectorDispositions.get("vector-winner")?.code).toBe("activated");
  });

  test("vector relevance competes under a token-only budget without mutating priority", () => {
    const keyword = makeEntry({ id: "token-keyword", order_value: 1, content: "k".repeat(160), priority: 10 });
    const vector = makeEntry({ id: "token-vector", order_value: 1000, content: "v".repeat(160), priority: 10 });

    const result = mergeActivatedWorldInfoEntries(
      [keyword],
      [asVectorCandidate(vector, 1)],
      { maxTokenBudget: 40 },
    );

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual(["token-vector"]);
    expect(result.activatedEntries[0]?.priority).toBe(10);
    expect(result.vectorDispositions.get("token-vector")?.code).toBe("activated");
  });

  test("group overrides apply across keyword and vector sources", () => {
    const keyword = makeEntry({ id: "group-keyword", group_name: "shared", priority: 50 });
    const vector = makeEntry({
      id: "group-vector",
      group_name: "shared",
      group_override: true,
      priority: 5,
    });

    const result = mergeActivatedWorldInfoEntries([keyword], [asVectorCandidate(vector, 1)]);

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual(["group-vector"]);
    expect(result.vectorDispositions.get("group-vector")?.code).toBe("activated");
  });

  test("group weights apply across keyword and vector sources", () => {
    const keyword = makeEntry({ id: "weighted-keyword", group_name: "weighted", group_weight: 1 });
    const vector = makeEntry({ id: "weighted-vector", group_name: "weighted", group_weight: 100 });
    const originalRandom = Math.random;
    Math.random = () => 0.99;
    try {
      const result = mergeActivatedWorldInfoEntries([keyword], [asVectorCandidate(vector, 1)]);
      expect(result.activatedEntries.map((entry) => entry.id)).toEqual(["weighted-vector"]);
      expect(result.vectorDispositions.get("weighted-vector")?.code).toBe("activated");
    } finally {
      Math.random = originalRandom;
    }
  });
});
