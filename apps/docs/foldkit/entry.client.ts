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

const prefetchSigning = (event: Event) => {
  const path = event.composedPath();
  if (![...document.querySelectorAll("[data-overlay=signer]")].some((node) => path.includes(node)))
    return;
  document.removeEventListener("pointerover", prefetchSigning);
  document.removeEventListener("focusin", prefetchSigning);
  void import("./signing-mount");
};
document.addEventListener("pointerover", prefetchSigning, { passive: true });
document.addEventListener("focusin", prefetchSigning);

window.addEventListener("pageswap", (event) => {
  const transition = event.viewTransition;
  if (transition === null) return;
  const ignore = () => undefined;
  transition.ready.catch(ignore);
  transition.finished.catch(ignore);
  transition.updateCallbackDone.catch(ignore);
});
