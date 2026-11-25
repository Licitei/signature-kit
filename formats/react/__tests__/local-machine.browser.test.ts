import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import {
  Cancel,
  Inspect,
  MachineCommand,
  MachineReply,
  Shutdown,
  Start,
} from "./local-machine-protocol";

const worker = Effect.acquireRelease(
  Effect.sync(
    () => new Worker(new URL("./local-machine.worker.ts", import.meta.url), { type: "module" }),
  ),
  (worker) => Effect.sync(() => worker.terminate()),
);

const exchange = (worker: Worker, message: unknown) =>
  Effect.callback<unknown>((resume, signal) => {
    worker.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => resume(Effect.succeed(event.data)),
      {
        once: true,
        signal,
      },
    );
    worker.postMessage(message);
  }).pipe(Effect.timeout("5 seconds"), Effect.flatMap(Schema.decodeUnknownEffect(MachineReply)));

const send = (worker: Worker, command: typeof MachineCommand.Type) =>
  Schema.encodeEffect(MachineCommand)(command).pipe(
    Effect.flatMap((message) => exchange(worker, message)),
  );

it(
  "rejects malformed and disabled events, then interrupts the worker's running Effect",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const local = yield* worker;
          expect(yield* send(local, Inspect.make({}))).toEqual({
            _tag: "State",
            path: "Idle",
            workerGlobal: "DedicatedWorkerGlobalScope",
            interrupted: false,
          });
          expect(yield* exchange(local, { _tag: "Start", hold: "no" })).toEqual({
            _tag: "Rejected",
            reason: "InvalidMessage",
          });
          expect(yield* send(local, Cancel.make({}))).toEqual({
            _tag: "Rejected",
            reason: "DisabledEvent",
          });
          expect(yield* send(local, Start.make({ hold: true }))).toMatchObject({
            _tag: "State",
            path: "Running",
            interrupted: false,
          });
          expect(yield* send(local, Cancel.make({}))).toEqual({
            _tag: "State",
            path: "Cancelled",
            workerGlobal: "DedicatedWorkerGlobalScope",
            interrupted: true,
          });
          expect(yield* send(local, Shutdown.make({}))).toEqual({ _tag: "Closed", stopped: true });
        }),
      ),
    ),
  20_000,
);

it(
  "completes worker-owned work and closes the machine scope",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const local = yield* worker;
          expect(yield* send(local, Start.make({ hold: false }))).toEqual({
            _tag: "State",
            path: "Done",
            workerGlobal: "DedicatedWorkerGlobalScope",
            interrupted: false,
          });
          expect(yield* send(local, Shutdown.make({}))).toEqual({ _tag: "Closed", stopped: true });
        }),
      ),
    ),
  20_000,
);
