import { Machine } from "@typeonce/effect-machine";
import { Effect, Schema } from "effect";
import { LocalError } from "./rpc.js";

const Review = Schema.TaggedStruct("Review", {});
const Confirm = Schema.TaggedStruct("Confirm", {});
const Drain = Schema.TaggedStruct("Drain", {});
const Complete = Schema.TaggedStruct("Complete", {});
const Cancel = Schema.TaggedStruct("Cancel", {});
const Fail = Schema.TaggedStruct("Fail", {});
const Retry = Schema.TaggedStruct("Retry", {});
const Event = Schema.Union([Review, Confirm, Drain, Complete, Cancel, Fail, Retry]);
type Event = typeof Event.Type;

const machine = Machine.make({
  root: Machine.state({
    states: {
      preparing: {},
      reviewing: {},
      confirming: {},
      draining: {},
      completed: {},
      cancelled: {},
      failed: {},
    },
  }),
  events: Machine.eventsFromSchemas(...Event.members),
}).handle({
  initial: { target: "preparing" },
  states: {
    preparing: { on: { Review: { target: "reviewing" }, Fail: { target: "failed" } } },
    reviewing: { on: { Confirm: { target: "confirming" }, Drain: { target: "draining" } } },
    confirming: { on: { Drain: { target: "draining" } } },
    draining: {
      on: {
        Complete: { target: "completed" },
        Cancel: { target: "cancelled" },
        Fail: { target: "failed" },
      },
    },
    completed: { on: { Retry: { target: "confirming" } } },
    cancelled: {},
    failed: {},
  },
});

export const startBatchMachine = Effect.gen(function* () {
  const ref = yield* Machine.start(machine).pipe(Effect.orDie);
  return Effect.fn(function* (event: Event) {
    const current = yield* ref.state;
    if (!(yield* Machine.can(machine, current, event).pipe(Effect.orDie))) {
      return yield* new LocalError({ code: "batchTransition" });
    }
    yield* ref.send(event).pipe(Effect.mapError(() => new LocalError({ code: "batchTransition" })));
    return (yield* ref.state).state.path;
  });
});
