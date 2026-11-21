import { describe, expect, it } from "@effect/vitest";

import {
  droidUsageAfterCompaction,
  formatDroidCost,
  formatDroidStatus,
  withDroidSlashCommands,
} from "./droidCommands.ts";

// Droid 1.16.0's reply to `droid.load_session`, trimmed to what `/cost` and `/status` read.
const LOADED = {
  session: { title: "Store code word ZEBRA-41" },
  settings: { reasoningEffort: "medium", autonomyMode: "auto-high" },
  cwd: "/private/tmp/droidproto/s1",
  tokenUsage: {
    inputTokens: 8,
    outputTokens: 330,
    cacheCreationTokens: 6_411,
    cacheReadTokens: 58_929,
    thinkingTokens: 132,
    factoryCredits: 625,
  },
  inclusiveTokenUsage: {
    inputTokens: 8,
    outputTokens: 330,
    cacheCreationTokens: 6_411,
    cacheReadTokens: 58_929,
    thinkingTokens: 132,
    factoryCredits: 625,
  },
  lastCallTokenUsage: { inputTokens: 360, outputTokens: 4, cacheReadTokens: 21_438 },
};

describe("formatDroidCost", () => {
  it("shows the session's tokens and the credits Droid recorded", () => {
    expect(formatDroidCost(LOADED)).toBe(
      [
        "**Cost** · 65.7k tokens · 625 Factory credits",
        "",
        "| Usage | Input | Output | Cache write | Cache read | Thinking | Credits |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        "| This session | 8 | 330 | 6.4k | 58.9k | 132 | 625 |",
        "| Last model call | 360 | 4 | – | 21.4k | – | – |",
        "",
        "These are Droid's own counts, not a price. Droid counts credits for every model; a model on your own key or subscription is not charged in Factory credits.",
      ].join("\n"),
    );
  });

  it("adds the sub-agents' share when it differs, and no credits Droid did not report", () => {
    expect(
      formatDroidCost({
        tokenUsage: { inputTokens: 1_200, outputTokens: 300 },
        inclusiveTokenUsage: { inputTokens: 5_200, outputTokens: 900 },
      }),
    ).toBe(
      [
        "**Cost** · 6.1k tokens",
        "",
        "| Usage | Input | Output | Cache write | Cache read | Thinking |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
        "| This session | 1.2k | 300 | – | – | – |",
        "| With sub-agents | 5.2k | 900 | – | – | – |",
        "",
        "These are Droid's own token counts for this session, not a price.",
      ].join("\n"),
    );
    expect(formatDroidCost({})).toBe("Droid has recorded no token usage for this session yet.");
  });
});

describe("formatDroidStatus", () => {
  it("shows what Droid reports about the session, without the account", () => {
    expect(
      formatDroidStatus({
        version: "1.16.0",
        sessionId: "24426c9c-7c4e-45c4-b646-7ec52f538d04",
        autonomyLevel: "Auto (High)",
        loaded: LOADED,
        breakdown: {
          modelDisplayName: "Claude Code Haiku 5.5",
          contextBudget: 600_000,
          usedTokens: 15_337,
          freeTokens: 584_663,
          categories: [],
        },
        mcpServers: [
          { name: "context7", status: "connected" },
          { name: "XcodeBuildMCP", status: "connecting" },
          { name: "linear", status: "failed" },
        ],
      }),
    ).toBe(
      [
        "**Status** · Droid 1.16.0",
        "",
        "| Setting | Value |",
        "| --- | --- |",
        "| Model | Claude Code Haiku 5.5 |",
        "| Reasoning effort | medium |",
        "| Autonomy level | Auto (High) |",
        "| Working directory | /private/tmp/droidproto/s1 |",
        "| Session | Store code word ZEBRA-41 · 24426c9c-7c4e-45c4-b646-7ec52f538d04 |",
        "| Context | 15.3k of 600k tokens (2.6%) |",
        "| MCP servers | 3 in Droid's settings: context7, XcodeBuildMCP, linear (failed) |",
      ].join("\n"),
    );
  });
});

describe("droidUsageAfterCompaction", () => {
  const breakdown = (usedTokens: number, lastCallCompactionTokens?: number) => ({
    modelDisplayName: "Haiku 5.5",
    contextBudget: 600_000,
    usedTokens,
    freeTokens: 600_000 - usedTokens,
    categories: [],
    ...(lastCallCompactionTokens === undefined ? {} : { lastCallCompactionTokens }),
  });

  it("takes what the estimate lost off the last model call's input", () => {
    expect(droidUsageAfterCompaction(breakdown(23_100, 33_688), breakdown(16_514, 33_688))).toBe(
      27_102,
    );
    // A short conversation's summary can be longer than what it replaced.
    expect(droidUsageAfterCompaction(breakdown(15_337, 21_802), breakdown(15_413, 21_802))).toBe(
      21_802,
    );
    expect(droidUsageAfterCompaction(undefined, breakdown(16_514))).toBe(16_514);
  });
});

describe("withDroidSlashCommands", () => {
  it("leaves a command Droid advertises under the same name to Droid", () => {
    expect(
      withDroidSlashCommands([
        { name: "review", description: "Review the changes" },
        { name: "Context", description: "A custom command" },
      ]).map((command) => `${command.name}: ${command.description}`),
    ).toEqual([
      "review: Review the changes",
      "Context: A custom command",
      "compact: Summarize the conversation to free up context",
      "cost: Show the tokens this session has used",
      "status: Show the session's model, settings and context",
    ]);
  });
});
