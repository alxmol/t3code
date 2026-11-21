import type * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

const DroidReply = Schema.Struct({
  id: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(DroidReply));

const READ_TIMEOUT = "30 seconds";
const EXIT_TIMEOUT = "5 seconds";

export const droidFailed = (detail: string, cause?: unknown) =>
  new EffectAcpErrors.AcpTransportError({ detail, cause });

/** Why a second Droid process could not answer, in words fit for the thread. */
export const droidFailureDetail = (error: EffectAcpErrors.AcpError) =>
  error._tag === "AcpTransportError" ? (error.detail ?? "") : "";

const frame = (id: string, method: string, params: unknown) =>
  `${JSON.stringify({
    factoryApiVersion: "1.0.0",
    factoryProtocolVersion: "1.0.0",
    type: "request",
    jsonrpc: "2.0",
    id,
    method,
    params,
  })}\n`;

export interface DroidSession {
  /** Droid's reply to `droid.load_session`. */
  readonly loaded: unknown;
  readonly request: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export interface AskDroidSessionOptions {
  readonly timeout?: Duration.Input;
  /** Lets Droid exit by itself, for a request that writes the session's files. */
  readonly awaitExit?: boolean;
}

export type AskDroidSession = <A>(
  sessionId: string,
  use: (session: DroidSession) => Effect.Effect<A, EffectAcpErrors.AcpError>,
  options?: AskDroidSessionOptions,
) => Effect.Effect<A, EffectAcpErrors.AcpError>;

/**
 * Droid answers no built-in command over ACP, so a second Droid loads the session through
 * Droid's own protocol and answers `use`'s requests. Loading writes nothing to the session.
 */
export const askDroidSession = Effect.fn("DroidSession.ask")(function* <A>(
  input: {
    readonly command: string;
    readonly env: NodeJS.ProcessEnv | undefined;
    readonly cwd: string;
    readonly sessionId: string;
  },
  use: (session: DroidSession) => Effect.Effect<A, EffectAcpErrors.AcpError>,
  options?: AskDroidSessionOptions,
) {
  const ask = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          input.command,
          [
            "exec",
            "--input-format",
            "stream-jsonrpc",
            "--output-format",
            "stream-jsonrpc",
            "--cwd",
            input.cwd,
          ],
          {
            cwd: input.cwd,
            ...(input.env ? { env: input.env } : {}),
            extendEnv: true,
            stdin: { stream: "pipe", endOnDone: true },
            stderr: "ignore",
            forceKillAfter: "2 seconds",
          },
        ),
      )
      .pipe(Effect.mapError((cause) => droidFailed("Could not start a second Droid.", cause)));
    const outgoing = yield* Queue.unbounded<string, Cause.Done>();
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.encodeText,
      Stream.run(child.stdin),
      Effect.ignore,
      Effect.forkScoped,
    );
    const replies = yield* Queue.unbounded<typeof DroidReply.Type, Cause.Done>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const reply = Option.getOrUndefined(decodeReply(line));
        return reply?.id === undefined ? Effect.void : Queue.offer(replies, reply);
      }),
      Effect.ignore,
      Effect.ensuring(Queue.end(replies)),
      Effect.forkScoped,
    );
    let requests = 0;
    const request = Effect.fnUntraced(function* (method: string, params: unknown) {
      requests += 1;
      const id = `t3-${requests}`;
      yield* Queue.offer(outgoing, frame(id, method, params));
      while (true) {
        const reply = yield* Queue.take(replies).pipe(
          Effect.mapError(() => droidFailed("Droid stopped before it answered.")),
        );
        if (reply.id !== id) continue;
        if (reply.error !== undefined) return yield* droidFailed(reply.error.message);
        return reply.result;
      }
    });
    const loaded = yield* request("droid.load_session", {
      sessionId: input.sessionId,
      messageLimit: 1,
    });
    const answer = yield* use({ loaded, request });
    if (options?.awaitExit === true) {
      yield* Queue.end(outgoing);
      yield* child.exitCode.pipe(Effect.timeoutOption(EXIT_TIMEOUT), Effect.ignore);
    }
    return answer;
  });
  return yield* ask.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: options?.timeout ?? READ_TIMEOUT,
      orElse: () => Effect.fail(droidFailed("Droid did not answer in time.")),
    }),
  );
});
