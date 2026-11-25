import { Machine } from "@typeonce/effect-machine";
import { Deferred, Effect, Result, Schema, Stream } from "effect";
import { MachineCommand, MachineEvent, MachineReply } from "./local-machine-protocol";

const states = Machine.state({
  states: { Idle: {}, Running: {}, Done: {}, Cancelled: {} },
});

const reply = (message: typeof MachineReply.Type) =>
  Schema.encodeEffect(MachineReply)(message).pipe(
    Effect.andThen((encoded) => Effect.sync(() => self.postMessage(encoded))),
  );

const run = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const machine = Machine.make({
    root: states,
    events: Machine.eventsFromSchemas(...MachineEvent.members),
    effects: {
      work: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
    },
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Start: { target: "Running" } } },
      Running: {
        invoke: { src: "work", onDone: { target: "Done" } },
        on: { Cancel: { target: "Cancelled" } },
      },
      Done: {},
      Cancelled: {},
    },
  });
  const ref = yield* Effect.scoped(
    Effect.gen(function* () {
      const ref = yield* Machine.start(machine);
      yield* Stream.fromEventListener<MessageEvent<unknown>>(self, "message").pipe(
        Stream.mapEffect((event) =>
          Effect.result(Schema.decodeUnknownEffect(MachineCommand)(event.data)),
        ),
        Stream.takeWhile(
          (command) => Result.isFailure(command) || command.success._tag !== "Shutdown",
        ),
        Stream.runForEach(
          Effect.fn(function* (command) {
            if (Result.isFailure(command)) {
              return yield* reply({ _tag: "Rejected", reason: "InvalidMessage" });
            }
            const event = command.success;
            if (event._tag === "Shutdown") return;
            if (event._tag === "Finish") {
              const state = yield* ref.state;
              if (state.state.path !== "Running") {
                return yield* reply({ _tag: "Rejected", reason: "DisabledEvent" });
              }
              yield* Deferred.succeed(release, undefined);
              yield* Machine.waitFor(ref, ({ state }) => state.state.path === "Done");
            } else if (event._tag !== "Inspect") {
              const state = yield* ref.state;
              if (!(yield* Machine.can(machine, state, event))) {
                return yield* reply({ _tag: "Rejected", reason: "DisabledEvent" });
              }
              yield* ref.send(event);
              yield* Deferred.await(event._tag === "Cancel" ? interrupted : entered);
            }
            const state = yield* ref.state;
            const path = state.state.path;
            yield* reply({
              _tag: "State",
              path,
              workerGlobal: self.constructor.name,
              interrupted: yield* Deferred.isDone(interrupted),
            });
          }),
        ),
      );
      return ref;
    }),
  );
  const { status } = yield* ref.snapshot;
  yield* reply({ _tag: "Closed", stopped: status === "stopped" });
}).pipe(Effect.ensuring(Effect.sync(() => self.close())));

await Effect.runPromise(run);
