import { defineBrowserCommand } from "@vitest/browser-playwright";
import type { BrowserContext, Request, Route } from "playwright";

declare module "vitest/browser" {
  interface BrowserCommands {
    blockLocalRuntimeNetwork: (blocked: boolean) => Promise<void>;
    trackLocalRuntimeRequests: (action: "start" | "read" | "stop") => Promise<string[]>;
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

const tracked = new WeakMap<
  BrowserContext,
  { readonly urls: string[]; readonly record: (request: Request) => void }
>();

export const trackLocalRuntimeRequests = defineBrowserCommand(
  ({ page }, action: "start" | "read" | "stop") => {
    const context = page.context();
    const active = tracked.get(context);
    if (action === "start") {
      if (active !== undefined) context.off("request", active.record);
      const urls: string[] = [];
      const record = (request: Request) => {
        urls.push(request.url());
      };
      tracked.set(context, { urls, record });
      context.on("request", record);
      return [];
    }
    if (action === "stop" && active !== undefined) {
      context.off("request", active.record);
      tracked.delete(context);
    }
    return active?.urls.slice() ?? [];
  },
);
