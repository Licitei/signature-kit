import { Runtime } from "foldkit";
import { initDocsPostHog } from "../lib/posthog/client";
import { Flags, Model, init, subscriptions, update, view } from "./main";
import "./styles/fonts";
import "./styles/transitions.css";

if (typeof window.requestIdleCallback === "function")
  window.requestIdleCallback(() => initDocsPostHog(), { timeout: 4000 });
else window.setTimeout(() => initDocsPostHog(), 2000);

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

window.addEventListener("pageswap", (event) => {
  const transition = event.viewTransition;
  if (transition === null) return;
  const ignore = () => undefined;
  transition.ready.catch(ignore);
  transition.finished.catch(ignore);
  transition.updateCallbackDone.catch(ignore);
});
