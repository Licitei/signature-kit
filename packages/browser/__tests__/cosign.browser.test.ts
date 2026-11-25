import { it } from "vitest";
import { commands } from "vitest/browser";

it("co-signs between independent Chromium contexts and compares in a third context", async () => {
  await commands.runCosignMilestone();
}, 60_000);
