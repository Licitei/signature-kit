import { defineBrowserCommand } from "@vitest/browser-playwright";
import type { Route } from "playwright";

declare module "vitest/browser" {
  interface BrowserCommands {
    blockLocalRuntimeNetwork: (blocked: boolean) => Promise<void>;
  }
}

const abortRequest = (route: Route) => route.abort();

export const blockLocalRuntimeNetwork = defineBrowserCommand(async ({ page }, blocked: boolean) => {
  const context = page.context();
  if (blocked) {
    await context.route("**/*", abortRequest);
  } else {
    await context.unroute("**/*", abortRequest);
  }
});
