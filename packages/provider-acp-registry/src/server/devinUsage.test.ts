import { describe, expect, it } from "@effect/vitest";

import {
  devinScreenText,
  devinUsageLimits,
  formatDevinUsage,
  parseDevinUsage,
} from "./devinUsage.ts";

// What Devin 3000.14's terminal app draws: its status line, then the `/usage` panel.
const SCREEN = [
  "\u001b[2J\u001b[1;1H  Devin CLI\u001b[2;1Hv3000.14.30821",
  "\u001b[12;1HFusion · Claude Fable 5.1 ◆ SWE-2 High\u001b[13;1HStarting session…",
  "\u001b[13;1H\u001b[2KMax · 89% remaining (resets in 1d 3h)",
  "\u001b[20;1H/usage\u001b[21;1H○ /usage              Show session usage of credits / ACUs",
  "\u001b[9;1H Fetching account usage…\u001b[9;1H\u001b[2KUsage\u001b[10;1HWeekly",
  "\u001b[11;3H\u001b[38;5;39m■■\u001b[38;5;240m■■■■■■■■■■■■■■■■■■\u001b[0m\u001b[11;25H  11% used",
  "\u001b[11;34H · resets in 1d 3h\u001b[13;1HExtra usage balance\u001b[14;3H$10.00",
  "\u001b[15;1HNo usage yet in this session.",
].join("");

describe("Devin usage", () => {
  it("reads the plan, each window and the extra balance from the terminal app's screen", () => {
    expect(parseDevinUsage(devinScreenText(SCREEN))).toEqual({
      plan: "Max",
      windows: [{ label: "Weekly", usedPercent: 11, resetsIn: "1d 3h" }],
      extraBalance: "$10.00",
    });
  });

  it("falls back to the status line when the panel never drew", () => {
    expect(parseDevinUsage("Starting session… Pro · 40% remaining (resets in 5h 2m) ❭")).toEqual({
      plan: "Pro",
      windows: [{ label: "Quota", usedPercent: 60, resetsIn: "5h 2m" }],
    });
    expect(parseDevinUsage("Devin CLI ❭ Ask Devin to build features")).toEqual({ windows: [] });
  });

  it("reports a window with the time it resets, and links to Devin's own usage page", () => {
    const now = Date.UTC(2026, 10, 21, 5, 0, 0);
    const externalUsage = { label: "Devin usage", url: "https://app.devin.ai/settings/usage" };
    expect(
      devinUsageLimits(
        { plan: "Max", windows: [{ label: "Weekly", usedPercent: 11, resetsIn: "1d 3h" }] },
        now,
      ),
    ).toEqual({
      checkedAt: "2026-11-21T05:00:00.000Z",
      windows: [
        {
          id: "devin_weekly",
          label: "Devin Weekly",
          kind: "weekly",
          windowDurationMins: 10_080,
          usedPercent: 11,
          resetsAt: "2026-11-22T08:00:00.000Z",
        },
      ],
      externalUsage,
    });
    // A reading that found nothing still leads to the page that has the figures.
    expect(devinUsageLimits(undefined, now)).toEqual({
      checkedAt: "2026-11-21T05:00:00.000Z",
      windows: [],
      unavailable: {
        reason: "probeFailed",
        message: "Devin's app did not show this account's usage.",
      },
      externalUsage,
    });
  });

  it("answers /usage with what is used and what is left", () => {
    expect(
      formatDevinUsage(
        { plan: "Max", windows: [{ label: "Weekly", usedPercent: 11, resetsIn: "1d 3h" }] },
        "Devin-ALX",
      ),
    ).toBe(
      [
        "**Usage** · Devin-ALX · Max plan",
        "",
        "| Window | Used | Left | Resets |",
        "| --- | ---: | ---: | --- |",
        "| Weekly | 11% | 89% | in 1d 3h |",
      ].join("\n"),
    );
  });
});
