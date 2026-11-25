import { it } from "vitest";
import { commands } from "vitest/browser";

it("archives fetched evidence as B-LTA and re-verifies it offline in another context", async () => {
  await commands.runLtvMilestone();
}, 60_000);
