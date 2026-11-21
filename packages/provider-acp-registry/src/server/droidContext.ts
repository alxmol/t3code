import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { droidFailed, type DroidSession } from "./droidSession.ts";

const Counted = Schema.Struct({ name: Schema.String, tokens: Schema.Number });

// Droid 1.16's `droid.get_context_breakdown`, the data behind `/context` in Factory's own apps.
const DroidContextBreakdown = Schema.Struct({
  modelDisplayName: Schema.String,
  contextBudget: Schema.Number,
  lastCallCompactionTokens: Schema.optional(Schema.Number),
  usedTokens: Schema.Number,
  freeTokens: Schema.Number,
  categories: Schema.Array(Counted),
  skills: Schema.optional(Schema.Array(Counted)),
  mcpServers: Schema.optional(
    Schema.Array(Schema.Struct({ ...Counted.fields, toolCount: Schema.Number })),
  ),
  droids: Schema.optional(Schema.Array(Counted)),
});
export type DroidContextBreakdown = typeof DroidContextBreakdown.Type;

const decodeBreakdown = Schema.decodeUnknownOption(DroidContextBreakdown);

const MAX_LISTED = 12;

const scaled = (value: number, unit: string) => `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
export const tokens = (value: number) =>
  value >= 999_950
    ? scaled(value / 1_000_000, "m")
    : value >= 1_000
      ? scaled(value / 1_000, "k")
      : String(Math.round(value));

export const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

export const droidContextUse = (breakdown: DroidContextBreakdown) =>
  `${tokens(breakdown.usedTokens)} of ${tokens(breakdown.contextBudget)} tokens (${(
    (breakdown.usedTokens / Math.max(breakdown.contextBudget, 1)) *
    100
  ).toFixed(1)}%)`;

export function formatDroidContextBreakdown(breakdown: DroidContextBreakdown): string {
  const budget = Math.max(breakdown.contextBudget, 1);
  const share = (value: number) => `${((value / budget) * 100).toFixed(1)}%`;
  const listed = (
    title: string,
    items: ReadonlyArray<{ readonly name: string; readonly tokens: number }> | undefined,
    detail: (item: { readonly name: string; readonly tokens: number }) => string = () => "",
  ) => {
    const used = (items ?? []).filter((item) => item.tokens > 0);
    if (used.length === 0) return [];
    const shown = used
      .toSorted((a, b) => b.tokens - a.tokens)
      .slice(0, MAX_LISTED)
      .map((item) => `${cell(item.name)} ${tokens(item.tokens)}${detail(item)}`);
    const more = used.length > MAX_LISTED ? [`${used.length - MAX_LISTED} more`] : [];
    return ["", `**${title}:** ${[...shown, ...more].join(" · ")}`];
  };
  const toolCounts = new Map(
    (breakdown.mcpServers ?? []).map((server) => [server.name, server.toolCount]),
  );
  return [
    `**Context** · ${cell(breakdown.modelDisplayName)} · ${droidContextUse(breakdown)}`,
    "",
    "| Category | Tokens | Share |",
    "| --- | ---: | ---: |",
    ...breakdown.categories
      .filter((category) => category.tokens > 0)
      .map(
        (category) =>
          `| ${cell(category.name)} | ${tokens(category.tokens)} | ${share(category.tokens)} |`,
      ),
    `| Free space | ${tokens(breakdown.freeTokens)} | ${share(breakdown.freeTokens)} |`,
    ...listed("MCP servers", breakdown.mcpServers, (server) => {
      const count = toolCounts.get(server.name) ?? 0;
      return ` (${count} ${count === 1 ? "tool" : "tools"})`;
    }),
    ...listed("Skills", breakdown.skills),
    ...listed("Custom droids", breakdown.droids),
    "",
    breakdown.lastCallCompactionTokens === undefined
      ? `Sizes are Droid's estimates. Droid compacts the conversation at ${tokens(breakdown.contextBudget)} tokens.`
      : `Sizes are Droid's estimates. The last model call used ${tokens(breakdown.lastCallCompactionTokens)} tokens, and Droid compacts the conversation at ${tokens(breakdown.contextBudget)}.`,
  ].join("\n");
}

export const readDroidContextBreakdown = Effect.fn("DroidContext.readBreakdown")(function* (
  session: DroidSession,
) {
  const breakdown = decodeBreakdown(yield* session.request("droid.get_context_breakdown", {}));
  if (Option.isNone(breakdown)) {
    return yield* droidFailed("Droid did not report the context in the expected shape.");
  }
  return breakdown.value;
});
