import { Schema } from "effect";

export const Start = Schema.TaggedStruct("Start", { hold: Schema.Boolean });
export const Cancel = Schema.TaggedStruct("Cancel", {});
export const Inspect = Schema.TaggedStruct("Inspect", {});
export const Shutdown = Schema.TaggedStruct("Shutdown", {});
export const MachineEvent = Schema.Union([Start, Cancel]);
export const MachineCommand = Schema.Union([MachineEvent, Inspect, Shutdown]);
export const MachineReply = Schema.Union([
  Schema.TaggedStruct("State", {
    path: Schema.Literals(["Idle", "Running", "Done", "Cancelled"]),
    workerGlobal: Schema.String,
    interrupted: Schema.Boolean,
  }),
  Schema.TaggedStruct("Rejected", {
    reason: Schema.Literals(["InvalidMessage", "DisabledEvent"]),
  }),
  Schema.TaggedStruct("Closed", { stopped: Schema.Boolean }),
]);
