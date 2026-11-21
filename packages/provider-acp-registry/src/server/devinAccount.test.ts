import { describe, expect, it } from "@effect/vitest";

import { parseDevinAuthStatus } from "./devinAccount.ts";

// `devin auth status` from Devin 3000.14, with the account's details replaced.
const LOGGED_IN = `Logged in (via Devin).

Credentials:
  File:              /Users/ada/.local/share/devin/credentials.toml
  API server:        https://server.codeium.com
  Devin webapp:      https://app.devin.ai
  Devin API:         https://api.devin.ai

User:
  Name:              Ada Lovelace
  Email:             ada@example.com
  User ID:           email|0123456789
`;

describe("parseDevinAuthStatus", () => {
  it("reads the sign-in state and the account's email", () => {
    expect(parseDevinAuthStatus(LOGGED_IN)).toEqual({
      status: "authenticated",
      email: "ada@example.com",
    });
    expect(parseDevinAuthStatus("Not logged in.\n")).toEqual({ status: "unauthenticated" });
    expect(parseDevinAuthStatus("error: unrecognized subcommand 'status'\n")).toBeUndefined();
  });
});
