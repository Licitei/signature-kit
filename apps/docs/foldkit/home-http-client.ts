import { Runtime } from "foldkit";
import posthog from "posthog-js";
import { docsPostHogOptions } from "../lib/posthog/client";
import { Flags, Model, init, subscriptions, update, view } from "./main";
import "./styles/fonts";

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
