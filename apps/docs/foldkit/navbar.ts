import * as stylex from "@stylexjs/stylex";
import { Popover } from "@foldkit/ui";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { docsNavigation } from "./content";
import { signFreePath } from "./home";
import { groupIcon, icon } from "./icons";
import type { IconName } from "./icons";
import { pageRoute } from "./routes";
import { sx } from "./styles/sx";
import { tokens } from "./styles/tokens.stylex";

export const NavMenuKind = Schema.Literals(["docs", "resources"]);
export type NavMenuKind = typeof NavMenuKind.Type;

export const navMenuInit = (kind: NavMenuKind) =>
  Popover.init({ id: `nav-${kind}`, isAnimated: true });

const groupBlurb: Record<string, string> = {
  "Comece aqui": "Instale e faça a primeira assinatura.",
  "Assinatura A1": "Assine PDF no navegador com certificado A1.",
  Receitas: "React, Promise, âncoras e tracing.",
  Conceitos: "Modelo mental, signers, formatos e runtime Effect.",
  Referência: "Certificados, PDF/PAdES, XML-DSig e erros.",
};

const resources: ReadonlyArray<{ title: string; hint: string; href: string; glyph: IconName }> = [
  { title: "Blog", hint: "Artigos e decisões de engenharia.", href: "/blog", glyph: "book" },
  { title: "Changelog", hint: "O que mudou em cada versão.", href: "/changelog", glyph: "list" },
  {
    title: "llms.txt",
    hint: "A documentação para agentes de IA.",
    href: "/llms.txt",
    glyph: "terminal",
  },
  {
    title: "GitHub",
    hint: "Código-fonte, issues e releases.",
    href: "https://github.com/Licitei/signature-kit",
    glyph: "external",
  },
];

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "8px 10px 8px 14px",
    borderWidth: 0,
    borderRadius: "8px",
    backgroundColor: { default: "transparent", ":hover": "rgba(127, 127, 127, 0.14)" },
    color: "inherit",
    opacity: { default: 0.82, ":hover": 1 },
    font: "inherit",
    fontSize: "0.875rem",
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    ":focus-visible": { outline: "none", boxShadow: tokens.focus },
  },
  triggerOn: {
    opacity: 1,
    backgroundColor: "rgba(127, 127, 127, 0.14)",
  },
  chevron: {
    display: "inline-flex",
    fontSize: "0.75rem",
    transitionProperty: "transform",
    transitionDuration: "200ms",
  },
  chevronOpen: {
    transform: "rotate(180deg)",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 49,
  },
  panel: {
    zIndex: 50,
    transformOrigin: "top left",
    transitionProperty: "opacity, transform",
    transitionDuration: "180ms",
    transitionTimingFunction: tokens.ease,
    padding: "8px",
    borderRadius: "16px",
    backgroundColor: tokens.bgElevated,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.line,
    boxShadow: "0 1px 2px rgba(13, 26, 32, 0.06), 0 28px 56px -18px rgba(13, 26, 32, 0.32)",
    color: tokens.fg,
    fontFamily: tokens.font,
    letterSpacing: "-0.011em",
    outline: "none",
  },
  panelClosed: {
    opacity: 0,
    transform: "translateY(-4px) scale(0.97)",
  },
  docsPanel: {
    display: "grid",
    gridTemplateColumns: "220px 400px",
    gap: "8px",
  },
  feature: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    minHeight: "236px",
    padding: "16px",
    overflow: "hidden",
    borderRadius: "11px",
    backgroundColor: tokens.ink,
    backgroundImage: "url(/landing/drop-chapada.webp)",
    backgroundSize: "cover",
    backgroundPosition: "center 30%",
    imageRendering: "pixelated",
    color: "#ffffff",
    textDecoration: "none",
    ":focus-visible": { outline: "none", boxShadow: tokens.focus },
  },
  featureShade: {
    position: "absolute",
    inset: 0,
    backgroundImage: "linear-gradient(transparent 30%, rgba(7, 24, 32, 0.92))",
  },
  featureTitle: {
    position: "relative",
    fontSize: "1rem",
    fontWeight: 600,
    letterSpacing: "-0.02em",
  },
  featureHint: {
    position: "relative",
    marginTop: "4px",
    color: "rgba(255, 255, 255, 0.78)",
    fontSize: "0.8125rem",
    lineHeight: 1.45,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "2px",
    alignContent: "start",
  },
  list: {
    display: "grid",
    gap: "2px",
    minWidth: "300px",
  },
  link: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    padding: "10px",
    borderRadius: "10px",
    color: "inherit",
    textDecoration: "none",
    backgroundColor: { default: "transparent", ":hover": tokens.bgSubtle },
    ":focus-visible": { outline: "none", backgroundColor: tokens.bgSubtle },
  },
  sheet: {
    display: "grid",
    gap: "20px",
  },
  sheetSearch: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "44px",
    paddingInline: "14px",
    borderRadius: "10px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.line,
    backgroundColor: tokens.bgElevated,
    color: tokens.muted,
    fontSize: "0.9375rem",
    textDecoration: "none",
    ":focus-visible": { outline: "none", boxShadow: tokens.focus },
  },
  sheetFeature: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    minHeight: "112px",
    padding: "16px",
    overflow: "hidden",
    borderRadius: "12px",
    backgroundColor: tokens.ink,
    backgroundImage: "url(/landing/drop-chapada.webp)",
    backgroundSize: "cover",
    backgroundPosition: "center 30%",
    imageRendering: "pixelated",
    color: "#ffffff",
    textDecoration: "none",
    ":focus-visible": { outline: "none", boxShadow: tokens.focus },
  },
  sheetLabel: {
    margin: "0 0 6px",
    color: tokens.faint,
    fontFamily: tokens.mono,
    fontSize: "0.75rem",
  },
  sheetRows: {
    display: "grid",
    gap: "2px",
    marginInline: "-10px",
  },
  sheetGroup: {
    marginTop: "14px",
  },
  sheetGroupTitle: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    margin: "0 0 4px",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  sheetList: {
    display: "grid",
    margin: "0 0 0 7px",
    padding: 0,
    listStyle: "none",
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderLeftColor: tokens.line,
  },
  sheetLink: {
    display: "block",
    marginLeft: "-1px",
    padding: "8px 0 8px 16px",
    borderLeftWidth: "1.5px",
    borderLeftStyle: "solid",
    borderLeftColor: "transparent",
    color: tokens.muted,
    fontSize: "0.9375rem",
    textDecoration: "none",
    ":focus-visible": { outline: "none", boxShadow: tokens.focus, borderRadius: "4px" },
  },
  sheetLinkOn: {
    borderLeftColor: tokens.teal,
    color: tokens.fg,
    fontWeight: 500,
  },
  glyph: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "32px",
    height: "32px",
    borderRadius: "9px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.line,
    backgroundColor: tokens.bg,
    color: tokens.teal,
    fontSize: "1rem",
  },
  text: {
    display: "grid",
    gap: "2px",
    minWidth: 0,
  },
  title: {
    fontSize: "0.875rem",
    fontWeight: 500,
    lineHeight: 1.3,
  },
  hint: {
    color: tokens.faint,
    fontSize: "0.75rem",
    lineHeight: 1.4,
  },
});

const row = <Message>(
  h: HtmlBuilder<Message>,
  input: { href: string; title: string; hint: string; glyph: Html },
) =>
  h.a(
    [...sx(h, styles.link), h.Href(input.href)],
    [
      h.span([...sx(h, styles.glyph)], [input.glyph]),
      h.span(
        [...sx(h, styles.text)],
        [
          h.span([...sx(h, styles.title)], [input.title]),
          h.span([...sx(h, styles.hint)], [input.hint]),
        ],
      ),
    ],
  );

const content = <Message>(h: HtmlBuilder<Message>, kind: NavMenuKind): Html => {
  if (kind === "docs")
    return h.div(
      [...sx(h, styles.docsPanel)],
      [
        h.a(
          [...sx(h, styles.feature), h.Href(signFreePath)],
          [
            h.span([...sx(h, styles.featureShade)]),
            h.span([...sx(h, styles.featureTitle)], ["Assinar PDF grátis"]),
            h.span(
              [...sx(h, styles.featureHint)],
              ["Com certificado A1, no navegador. Nada é enviado a servidores."],
            ),
          ],
        ),
        h.div(
          [...sx(h, styles.grid)],
          docsNavigation()
            .filter((group) => groupBlurb[group.title] !== undefined)
            .map((group) =>
              h.keyed("div")(
                group.title,
                [],
                [
                  row(h, {
                    href: group.links[0]?.href ?? pageRoute({ path: "docs" }),
                    title: group.title,
                    hint: groupBlurb[group.title] ?? "",
                    glyph: icon(h, groupIcon(group.title)),
                  }),
                ],
              ),
            ),
        ),
      ],
    );
  return h.div(
    [...sx(h, styles.list)],
    resources.map((resource) =>
      h.keyed("div")(
        resource.title,
        [],
        [
          row(h, {
            href: resource.href,
            title: resource.title,
            hint: resource.hint,
            glyph: icon(h, resource.glyph),
          }),
        ],
      ),
    ),
  );
};

export const mobileMenuView = <Message>(
  h: HtmlBuilder<Message>,
  input: { docs: boolean; currentRoute: string; search: Message; close: Message },
) =>
  h.div(
    [...sx(h, styles.sheet)],
    [
      h.a(
        [
          ...sx(h, styles.sheetSearch),
          h.Href(pageRoute({ path: "search" })),
          h.OnClick(input.search, { defaultAction: "Prevent" }),
        ],
        [icon(h, "search"), "Buscar na documentação"],
      ),
      h.a(
        [...sx(h, styles.sheetFeature), h.Href(signFreePath), h.OnClick(input.close)],
        [
          h.span([...sx(h, styles.featureShade)]),
          h.span([...sx(h, styles.featureTitle)], ["Assinar PDF grátis"]),
          h.span(
            [...sx(h, styles.featureHint)],
            ["Com certificado A1, no navegador. Nada é enviado a servidores."],
          ),
        ],
      ),
      h.div(
        [],
        [
          h.p([...sx(h, styles.sheetLabel)], ["Documentação"]),
          ...(input.docs
            ? docsNavigation().map((group) =>
                h.keyed("div")(
                  group.title,
                  [...sx(h, styles.sheetGroup)],
                  [
                    h.p(
                      [...sx(h, styles.sheetGroupTitle)],
                      [icon(h, groupIcon(group.title)), group.title],
                    ),
                    h.ul(
                      [...sx(h, styles.sheetList)],
                      group.links.map((link) =>
                        h.keyed("li")(
                          link.href,
                          [],
                          [
                            h.a(
                              [
                                ...sx(
                                  h,
                                  styles.sheetLink,
                                  link.href === input.currentRoute && styles.sheetLinkOn,
                                ),
                                h.Href(link.href),
                                ...(link.href === input.currentRoute
                                  ? [h.AriaCurrent("page")]
                                  : []),
                              ],
                              [link.title],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              )
            : [
                h.div(
                  [...sx(h, styles.sheetRows)],
                  docsNavigation()
                    .filter((group) => groupBlurb[group.title] !== undefined)
                    .map((group) =>
                      h.keyed("div")(
                        group.title,
                        [],
                        [
                          row(h, {
                            href: group.links[0]?.href ?? pageRoute({ path: "docs" }),
                            title: group.title,
                            hint: groupBlurb[group.title] ?? "",
                            glyph: icon(h, groupIcon(group.title)),
                          }),
                        ],
                      ),
                    ),
                ),
              ]),
        ],
      ),
      h.div(
        [],
        [
          h.p([...sx(h, styles.sheetLabel)], ["Recursos"]),
          h.div(
            [...sx(h, styles.sheetRows)],
            resources.map((resource) =>
              h.keyed("div")(
                resource.title,
                [],
                [
                  row(h, {
                    href: resource.href,
                    title: resource.title,
                    hint: resource.hint,
                    glyph: icon(h, resource.glyph),
                  }),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );

const labels: Record<NavMenuKind, string> = {
  docs: "Docs",
  resources: "Recursos",
};

export const navMenuView = <Message>(
  h: HtmlBuilder<Message>,
  input: {
    kind: NavMenuKind;
    model: Popover.Model;
    current: boolean;
    toParentMessage: (message: Popover.Message) => Message;
  },
) =>
  h.submodel({
    slotId: `nav-${input.kind}`,
    model: input.model,
    view: Popover.view,
    viewInputs: {
      ariaLabel: labels[input.kind],
      anchor: { placement: "bottom-start", gap: 10, padding: 12 },
      toView: ({ button, panel, backdrop, isVisible }) =>
        h.div(
          [],
          [
            h.button(
              [
                ...button,
                ...sx(h, styles.trigger, (input.current || isVisible) && styles.triggerOn),
              ],
              [
                labels[input.kind],
                h.span(
                  [...sx(h, styles.chevron, isVisible && styles.chevronOpen)],
                  [icon(h, "chevron")],
                ),
              ],
            ),
            ...(isVisible
              ? [
                  h.div([...backdrop, ...sx(h, styles.backdrop)]),
                  h.div(
                    [
                      ...panel,
                      ...sx(
                        h,
                        styles.panel,
                        (input.model.animation.transitionState === "EnterStart" ||
                          input.model.animation.transitionState === "LeaveAnimating") &&
                          styles.panelClosed,
                      ),
                    ],
                    [content(h, input.kind)],
                  ),
                ]
              : []),
          ],
        ),
    },
    toParentMessage: input.toParentMessage,
  });
