import type { ServerProviderAuth } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const READ_TIMEOUT = "10 seconds";

/** Reads what `devin auth status` prints; Devin names its account nowhere over ACP. */
export function parseDevinAuthStatus(
  output: string,
): Pick<ServerProviderAuth, "status" | "email"> | undefined {
  if (/^Not logged in\b/m.test(output)) return { status: "unauthenticated" };
  if (!/^Logged in\b/m.test(output)) return undefined;
  const email = /^\s*Email:\s+(\S+@\S+)\s*$/m.exec(output)?.[1];
  return { status: "authenticated", ...(email === undefined ? {} : { email }) };
}

/** Asks Devin which account an instance's environment holds. Starts no session, uses no model. */
export const readDevinAccount = Effect.fn("DevinAccount.read")(
  function* (input: { readonly command: string; readonly env: NodeJS.ProcessEnv | undefined }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(input.command, ["auth", "status"], {
        ...(input.env ? { env: input.env } : {}),
        extendEnv: true,
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: "2 seconds",
      }),
    );
    const output = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (all, text) => `${all}${text}`,
      ),
    );
    return parseDevinAuthStatus(output);
  },
  Effect.scoped,
  Effect.timeout(READ_TIMEOUT),
  Effect.orElseSucceed(() => undefined),
);
