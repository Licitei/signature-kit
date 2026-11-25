import { Runtime } from "foldkit";
import { Flags, Model, init, subscriptions, update, view } from "./main";
import "./styles/fonts";

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
