import { Dialog } from "@foldkit/ui";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { overlay } from "./styles/overlay";
import { sx } from "./styles/sx";

export const OverlayKind = Schema.Literals(["signer", "providers", "quickstart", "menu", "search"]);
export type OverlayKind = typeof OverlayKind.Type;

export const overlayView = <Message>(
  h: HtmlBuilder<Message>,
  input: {
    model: Dialog.Model;
    kind: OverlayKind;
    title: string;
    closeLabel: string;
    panels: ReadonlyArray<readonly [OverlayKind, Html]>;
    layer: ReadonlyArray<Html>;
    toParentMessage: (message: Dialog.Message) => Message;
  },
) => {
  const state = input.model.animation.transitionState;
  const closed = state === "EnterStart" || state === "LeaveAnimating";
  const modal = input.kind === "providers" || input.kind === "search";
  return h.submodel({
    slotId: "site-overlay",
    model: input.model,
    view: Dialog.view,
    viewInputs: {
      toView: ({ dialog, backdrop, panel, title, closeButton }) =>
        h.dialog(
          [...dialog, ...sx(h, overlay.root)],
          [
            h.div([...backdrop, ...sx(h, overlay.backdrop, closed && overlay.backdropClosed)]),
            h.div(
              [
                ...panel,
                ...sx(
                  h,
                  overlay.panel,
                  modal ? overlay.modal : overlay.sheet,
                  input.kind === "signer" && overlay.sheetWide,
                  closed && (modal ? overlay.modalClosed : overlay.sheetClosed),
                ),
              ],
              [
                h.div(
                  [...sx(h, overlay.head)],
                  [
                    h.h2([...title, ...sx(h, overlay.title)], [input.title]),
                    h.button(
                      [
                        ...closeButton,
                        ...(input.kind === "search" ? [] : [h.DataAttribute("overlay-focus", "")]),
                        ...sx(h, overlay.close),
                        h.AriaLabel(input.closeLabel),
                      ],
                      ["✕"],
                    ),
                  ],
                ),
                h.div(
                  [...sx(h, overlay.body)],
                  input.panels.map(([kind, content]) =>
                    h.div(kind === input.kind ? [] : [h.Hidden(true)], [content]),
                  ),
                ),
              ],
            ),
            ...input.layer,
          ],
        ),
    },
    toParentMessage: input.toParentMessage,
  });
};
