import { Effect, Schema } from "effect";
import * as Mount from "foldkit/mount";
import type { HtmlBuilder } from "foldkit/html";
import * as stylex from "@stylexjs/stylex";
import { sx } from "./styles/sx";
import { tokens } from "./styles/tokens.stylex";

const styles = stylex.create({
  frame: {
    position: "relative",
    display: "grid",
    justifyItems: "center",
    margin: "24px 0",
    padding: { default: "28px 20px", "@media (max-width: 640px)": "20px 12px" },
    borderRadius: "14px",
    backgroundColor: tokens.bgSubtle,
    overflow: "hidden",
  },
  output: {
    display: "grid",
    justifyItems: "center",
    width: "100%",
    maxWidth: "560px",
    overflowX: "auto",
  },
});

const MermaidMount = Mount.define("MermaidMount", {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.gen(function* () {
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const workspace = document.createElement("div");
          workspace.setAttribute("data-mermaid-workspace", "");
          workspace.style.position = "absolute";
          workspace.style.visibility = "hidden";
          workspace.style.top = "0";
          workspace.style.left = "0";
          workspace.style.width = "720px";
          element.append(workspace);
          return { workspace, active: true };
        }),
        (resource) =>
          Effect.sync(() => {
            resource.active = false;
            resource.workspace.remove();
          }),
      );
      const source = element.querySelector("code")?.textContent ?? "";
      yield* Effect.promise(() =>
        import("mermaid")
          .then(async ({ default: mermaid }) => {
            if (!resource.active) return;
            element.setAttribute("data-mermaid-state", "rendering");
            element.setAttribute("aria-busy", "true");
            mermaid.initialize({
              startOnLoad: false,
              securityLevel: "strict",
              theme: "base",
              fontFamily: "Geist Variable, Geist, ui-sans-serif, system-ui, sans-serif",
              flowchart: { curve: "linear", nodeSpacing: 36, rankSpacing: 44, padding: 14 },
              themeVariables: {
                fontSize: "14px",
                background: "#f1efe9",
                primaryColor: "#ffffff",
                primaryTextColor: "#0d1a20",
                primaryBorderColor: "#0B5275",
                lineColor: "#0B5275",
                secondaryColor: "#eef5f8",
                tertiaryColor: "#fafaf7",
                edgeLabelBackground: "#f1efe9",
              },
            });
            const result = await mermaid.render(
              `mermaid-${crypto.randomUUID()}`,
              source,
              resource.workspace,
            );
            if (resource.active) {
              const output = element.querySelector("[data-mermaid-output]");
              const fallback = element.querySelector("[data-mermaid-fallback]");
              if (output !== null && fallback !== null) {
                output.innerHTML = result.svg;
                fallback.remove();
                element.setAttribute("data-mermaid-state", "ready");
                element.setAttribute("aria-busy", "false");
              }
            }
          })
          .then(
            () => resource.workspace.remove(),
            () => {
              resource.workspace.remove();
              if (resource.active) {
                element.setAttribute("data-mermaid-state", "error");
                element.setAttribute("aria-busy", "false");
                element.setAttribute(
                  "aria-label",
                  "Não foi possível desenhar o diagrama; o código-fonte vem a seguir",
                );
              }
            },
          ),
      );
      return yield* Effect.never;
    }),
});

export const mermaidView = <Message>(
  h: HtmlBuilder<Message>,
  source: string,
  meta?: string | null,
) =>
  h.div(
    [
      ...sx(h, styles.frame),
      h.OnMount(MermaidMount()),
      h.Attribute("data-mermaid-state", "rendering"),
      h.Attribute("aria-busy", "true"),
    ],
    [
      meta != null && meta.length > 0 ? h.p([], [meta]) : null,
      h.div([...sx(h, styles.output), h.Attribute("data-mermaid-output", "")]),
      h.div(
        [h.Attribute("data-mermaid-fallback", "")],
        [h.pre([], [h.code([h.Class("language-mermaid")], [source])])],
      ),
    ],
  );
