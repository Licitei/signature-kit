import { Runtime } from "foldkit";
import { initDocsAnalytics } from "./analytics";
import { Flags, Model, init, subscriptions, update, view } from "./main";
import "./styles/fonts";
import "./styles/transitions.css";

if (typeof window.requestIdleCallback === "function")
  window.requestIdleCallback(() => initDocsAnalytics(), { timeout: 4000 });
else window.setTimeout(() => initDocsAnalytics(), 2000);

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

if (document.querySelector("[data-overlay=signer], form:has([name=pfx])") !== null) {
  const prefetchSigning = () => void import("./signing-mount");
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(prefetchSigning, { timeout: 1500 });
  else window.setTimeout(prefetchSigning, 500);
}

window.addEventListener("pageswap", (event) => {
  const transition = event.viewTransition;
  if (transition === null) return;
  const ignore = () => undefined;
  transition.ready.catch(ignore);
  transition.finished.catch(ignore);
  transition.updateCallbackDone.catch(ignore);
});
