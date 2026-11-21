import { describe, expect, it } from "@effect/vitest";

import { formatDroidContextBreakdown } from "./droidContext.ts";

describe("formatDroidContextBreakdown", () => {
  // Droid 1.16.0's reply to `droid.get_context_breakdown`, trimmed.
  it("shows Droid's own figures against the compaction limit", () => {
    expect(
      formatDroidContextBreakdown({
        modelDisplayName: "Haiku 5.5",
        contextBudget: 600_000,
        lastCallCompactionTokens: 30_380,
        usedTokens: 21_908,
        freeTokens: 578_092,
        categories: [
          { name: "System prompt", tokens: 2_552 },
          { name: "System tools", tokens: 10_608 },
          { name: "AGENTS.md", tokens: 0 },
          { name: "Messages", tokens: 6_422 },
          { name: "User info", tokens: 1_990 },
        ],
        skills: [{ name: "droid-control", tokens: 52 }],
        mcpServers: [
          { name: "context7", toolCount: 2, tokens: 14 },
          { name: "XcodeBuildMCP", toolCount: 24, tokens: 190 },
        ],
        droids: [],
      }),
    ).toBe(
      [
        "**Context** · Haiku 5.5 · 21.9k of 600k tokens (3.7%)",
        "",
        "| Category | Tokens | Share |",
        "| --- | ---: | ---: |",
        "| System prompt | 2.6k | 0.4% |",
        "| System tools | 10.6k | 1.8% |",
        "| Messages | 6.4k | 1.1% |",
        "| User info | 2k | 0.3% |",
        "| Free space | 578.1k | 96.3% |",
        "",
        "**MCP servers:** XcodeBuildMCP 190 (24 tools) · context7 14 (2 tools)",
        "",
        "**Skills:** droid-control 52",
        "",
        "Sizes are Droid's estimates. The last model call used 30.4k tokens, and Droid compacts the conversation at 600k.",
      ].join("\n"),
    );
  });
});
