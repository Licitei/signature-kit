import { pageRoute } from "./routes";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import * as Mount from "foldkit/mount";
import type { HtmlBuilder } from "foldkit/html";
import { landing } from "./styles/landing";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";
import en from "../messages/en-US.json";
import pt from "../messages/pt-BR.json";
import type { Locale } from "./content";

export const Theme = Schema.Literals(["light", "dark"]);
export const ThemeLoaded = Schema.TaggedStruct("ThemeLoaded", { theme: Theme });
export const ThemeMount = Mount.define("ThemeMount", {
  messages: [ThemeLoaded],
  execute: ({ element }) =>
    Effect.try({
      try: (): typeof Theme.Type => {
        const theme = localStorage.getItem("signaturekit-theme") === "dark" ? "dark" : "light";
        element.setAttribute("data-theme", theme);
        return theme;
      },
      catch: () => "light",
    }).pipe(
      Effect.orElseSucceed((): typeof Theme.Type => "light"),
      Effect.map((theme) => ThemeLoaded.make({ theme })),
    ),
});
export const ThemeSaved = Schema.TaggedStruct("ThemeSaved", {});
export const SaveTheme = Command.define("SaveTheme", {
  args: { theme: Theme },
  messages: [ThemeSaved],
  execute: ({ theme }) =>
    Effect.try({
      try: () => localStorage.setItem("signaturekit-theme", theme),
      catch: () => undefined,
    }).pipe(Effect.ignore, Effect.as(ThemeSaved.make({}))),
});

export const brandMark = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 24 24"), h.AriaHidden(true), ...sx(h, landing.brandMark)],
    [
      h.circle([h.Cx("12"), h.Cy("12"), h.R("11"), ...sx(h, landing.markDisc)]),
      h.path([h.D("M7 12.5l3.2 3.2L17 9"), ...sx(h, landing.markCheck)]),
    ],
  );

const seal = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 240 240"), h.AriaHidden(true), ...sx(h, landing.seal)],
    [
      h.defs(
        [],
        [h.path([h.Id("seal-orbit"), h.D("M120 120m-88 0a88 88 0 1 1 176 0a88 88 0 1 1 -176 0")])],
      ),
      h.circle([h.Cx("120"), h.Cy("120"), h.R("112"), ...sx(h, landing.sealRing)]),
      h.circle([h.Cx("120"), h.Cy("120"), h.R("100"), ...sx(h, landing.sealDash)]),
      h.text(
        [...sx(h, landing.sealText)],
        [
          h.textPath(
            [h.Attribute("href", "#seal-orbit"), h.Attribute("textLength", "548")],
            ["SIGNATUREKIT · EFFECT · WEBCRYPTO · OFFLINE · "],
          ),
        ],
      ),
      h.circle([h.Cx("120"), h.Cy("120"), h.R("64"), ...sx(h, landing.sealCore)]),
      h.path([h.D("M96 122l16 16 32-34"), ...sx(h, landing.sealCheck)]),
    ],
  );

export const homeView = <Message>(h: HtmlBuilder<Message>, locale: Locale) => {
  const copy = locale === "pt-BR" ? pt : en;
  return h.section(
    [...sx(h, landing.hero)],
    [
      h.div(
        [...sx(h, landing.heroGrid)],
        [
          h.div(
            [...sx(h, landing.heroCopy)],
            [
              h.h1([...sx(h, landing.title)], [copy.hero_title]),
              h.p([], [copy.hero_subhead]),
              h.div(
                [...sx(h, landing.actions)],
                [
                  h.a(
                    [
                      ...sx(h, shell.primary, landing.wide),
                      h.Href(pageRoute({ locale, path: "docs" })),
                    ],
                    [copy.hero_cta_docs],
                  ),
                ],
              ),
            ],
          ),
          h.div([...sx(h, landing.visual)], [seal(h)]),
        ],
      ),
    ],
  );
};
