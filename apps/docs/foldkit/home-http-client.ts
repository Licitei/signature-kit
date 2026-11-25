import { Runtime } from "foldkit";
import posthog from "posthog-js";
import { docsPostHogOptions } from "../lib/posthog/client";
import { Flags, Model, init, subscriptions, update, view } from "./main";
import "./styles/fonts";

if (!("__vitest_browser_runner__" in window))
  Object.assign(window, {
    __vitest_browser_runner__: { wrapDynamicImport: <T>(load: () => Promise<T>) => load() },
  });

posthog.init("local-home-test-token", { ...docsPostHogOptions, opt_out_useragent_filter: true });

Runtime.hydrate(
  Runtime.makeApplication({
    Flags,
    Model,
    init,
    update,
    view,
    subscriptions,
    container: document.querySelector<HTMLElement>("[data-foldkit-app]"),
  }),
  { buildId: "home-http-test" },
);
