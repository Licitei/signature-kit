import { Runtime } from "foldkit";
import { inView } from "motion";
import { animate } from "motion/mini";
import { initDocsAnalytics } from "./analytics";
import { contentTargetsFor, loadContentTargets } from "./content";
import { Flags, Model, init, signerReadyEvent, subscriptions, update, view } from "./main";
import "./styles/fonts";
import "./styles/transitions.css";

if (typeof window.requestIdleCallback === "function")
  window.requestIdleCallback(() => initDocsAnalytics(), { timeout: 4000 });
else window.setTimeout(() => initDocsAnalytics(), 2000);

await loadContentTargets(contentTargetsFor(window.location.pathname));

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
  const prefetchSigning = () =>
    void import("./signing-mount").then(() => document.dispatchEvent(new Event(signerReadyEvent)));
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(prefetchSigning, { timeout: 1500 });
  else window.setTimeout(prefetchSigning, 500);
}

document.addEventListener("click", (event) => {
  const path = event.composedPath();
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-copy-code]")].find(
    (node) => path.includes(node),
  );
  const code = button?.parentElement?.parentElement?.querySelector("pre")?.textContent;
  if (button === undefined || code === undefined || code === null) return;
  void navigator.clipboard.writeText(code).then(
    () => {
      button.setAttribute("aria-label", "Copiado");
      button.dataset.copied = "true";
      setTimeout(() => {
        button.setAttribute("aria-label", "Copiar código");
        delete button.dataset.copied;
      }, 1500);
    },
    () => button.setAttribute("aria-label", "Não foi possível copiar"),
  );
});

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const ease: [number, number, number, number] = [0.23, 1, 0.32, 1];
  for (const element of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
    if (element.getBoundingClientRect().top < window.innerHeight) continue;
    const targets = element.hasAttribute("data-reveal-stagger")
      ? [...element.querySelectorAll<HTMLElement>(":scope > *")]
      : [element];
    for (const target of targets) target.style.opacity = "0";
    inView(
      element,
      () => {
        targets.forEach((target, index) => {
          void animate(
            target,
            { opacity: [0, 1], transform: ["translateY(14px)", "translateY(0px)"] },
            { duration: 0.55, ease, delay: index * 0.06 },
          ).finished.then(() => {
            target.style.opacity = "";
          });
        });
      },
      { margin: "0px 0px -12% 0px" },
    );
  }
}

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  for (const element of document.querySelectorAll<HTMLElement>("[data-count]")) {
    if (element.getBoundingClientRect().top < window.innerHeight) continue;
    const target = Number(element.dataset.count);
    const decimals = Number(element.dataset.countDecimals ?? "0");
    if (!Number.isFinite(target)) continue;
    const format = (value: number) =>
      value.toLocaleString("pt-BR", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    element.textContent = format(0);
    inView(element, () => {
      const start = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / 900);
        element.textContent = format(target * (1 - (1 - progress) ** 4));
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-grow]")) {
    if (element.getBoundingClientRect().top < window.innerHeight) continue;
    element.style.transform = "scaleX(0)";
    inView(
      element,
      () => {
        void animate(
          element,
          { transform: ["scaleX(0)", "scaleX(1)"] },
          { duration: 0.9, ease: [0.23, 1, 0.32, 1] },
        ).finished.then(() => {
          element.style.transform = "";
        });
      },
      { margin: "0px 0px -8% 0px" },
    );
  }
}

window.addEventListener("pageswap", (event) => {
  const transition = event.viewTransition;
  if (transition === null) return;
  const ignore = () => undefined;
  transition.ready.catch(ignore);
  transition.finished.catch(ignore);
  transition.updateCallbackDone.catch(ignore);
});
