import * as stylex from "@stylexjs/stylex";
import { Popover } from "@foldkit/ui";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { docsNavigation } from "./content";
import { homeProviders, signFreePath } from "./home";
import { groupIcon, icon } from "./icons";
import type { IconName } from "./icons";
import { pageRoute } from "./routes";
import { sx } from "./styles/sx";
import { tokens } from "./styles/tokens.stylex";

export const NavMenuKind = Schema.Literals(["docs", "providers", "resources"]);
export type NavMenuKind = typeof NavMenuKind.Type;

export const navMenuInit = (kind: NavMenuKind) =>
  Popover.init({ id: `nav-${kind}`, isAnimated: true });

const groupBlurb: Record<string, string> = {
  "Comece aqui": "Instale e assine os primeiros bytes.",
  "Assinatura A1": "PDF no navegador com certificado A1.",
  Receitas: "React, Promise, âncoras e tracing.",
  Conceitos: "O modelo mental e a fronteira do signer.",
  "APIs de provedores": "Clicksign, Assinafy, ZapSign e outros.",
  Signers: "Certificados, PDF/PAdES, XML-DSig e erros.",
};

const providerBlurb: Record<string, string> = {
  clicksign: "Documento e signatário, um por request.",
  assinafy: "Documento, signatário e assignment.",
  zapsign: "Upload de PDF e URL de assinatura.",
  docuseal: "Submissões com ordem de signatários.",
  documenso: "Envelopes com aprovadores e signatários.",
};

const resources: ReadonlyArray<{ title: string; hint: string; href: string; glyph: IconName }> = [
  { title: "Blog", hint: "Histórias e decisões de engenharia.", href: "/blog", glyph: "book" },
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
  logo: {
    display: "block",
    maxWidth: "22px",
    maxHeight: "18px",
    objectFit: "contain",
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
  providerHead: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  providerName: {
    fontSize: "0.9375rem",
    fontWeight: 600,
    letterSpacing: "-0.02em",
  },
  providerLogo: {
    display: "block",
    height: "18px",
    width: "auto",
    maxWidth: "110px",
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
              ["Certificado A1 no navegador. Nada é enviado para servidor."],
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
  if (kind === "providers")
    return h.div(
      [...sx(h, styles.list)],
      homeProviders.map((provider) =>
        h.keyed("div")(
          provider.slug,
          [],
          [
            h.a(
              [
                ...sx(h, styles.link),
                h.Href(pageRoute({ path: `docs/providers/${provider.slug}` })),
              ],
              [
                h.span(
                  [...sx(h, styles.text)],
                  [
                    h.span(
                      [...sx(h, styles.providerHead)],
                      [
                        h.img([
                          h.Src(provider.logo),
                          h.Alt(provider.slug === "docuseal" ? "" : provider.name),
                          h.Height("18"),
                          h.Width(String(Math.round((18 * provider.width) / provider.height))),
                          ...sx(h, styles.providerLogo),
                        ]),
                        ...(provider.slug === "docuseal"
                          ? [h.span([...sx(h, styles.providerName)], ["DocuSeal"])]
                          : []),
                      ],
                    ),
                    h.span([...sx(h, styles.hint)], [providerBlurb[provider.slug] ?? ""]),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
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

const labels: Record<NavMenuKind, string> = {
  docs: "Docs",
  providers: "Provedores",
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
