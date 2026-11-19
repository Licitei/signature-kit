import { Runtime } from "foldkit";
import { initDocsPostHog } from "../lib/posthog/client";
import { Flags, Model, init, update, view } from "./main";
import "./styles/fonts";

initDocsPostHog();

Runtime.hydrate(
  Runtime.makeApplication({
    Flags,
    Model,
    init,
    update,
    view,
    container: document.querySelector<HTMLElement>("[data-foldkit-app]"),
  }),
);
