import { Runtime } from "foldkit";
import { initDocsPostHog } from "../lib/posthog/client";
import { Flags, Model, init, subscriptions, update, view } from "./main";
import "./styles/fonts";

initDocsPostHog();

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
);
