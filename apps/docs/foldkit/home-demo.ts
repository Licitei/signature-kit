import { Button, Tabs } from "@foldkit/ui";
import { Effect, Exit, Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { defineView } from "foldkit/submodel";
import * as Mount from "foldkit/mount";
import { captureDocsEvent } from "../lib/posthog/client";
import { landing } from "./styles/landing";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";

const DemoIndex = Schema.Literals(["0", "1", "2", "3"]);
const DemoTabs = Tabs.create<typeof DemoIndex.Type>();
const demoIndexes = ["0", "1", "2", "3"] satisfies ReadonlyArray<typeof DemoIndex.Type>;

const DemoMounted = Schema.TaggedStruct("DemoMounted", {});
const DemoMount = Mount.define("DemoMount", {
  messages: [DemoMounted],
  execute: ({ element }) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const names = [
            "Contrato de serviços",
            "Aditivo contratual",
            "Procuração",
            "Termo de adesão",
          ];
          const variants = ["line", "field", "witnessed", "initials"] satisfies (
            | "line"
            | "field"
            | "witnessed"
            | "initials"
          )[];
          const preview = element.querySelector<HTMLIFrameElement>("[data-demo-preview]");
          const status = element.querySelector<HTMLElement>("[data-demo-status]");
          const download = element.querySelector<HTMLAnchorElement>("[data-demo-download]");
          const run = element.querySelector<HTMLButtonElement>("[data-demo-run]");
          const reset = element.querySelector<HTMLButtonElement>("[data-demo-reset]");
          let active = Number(element.getAttribute("data-active") ?? "0");
          let generation = 0;
          let closed = false;
          let urls: string[] = [];
          let controller: AbortController | undefined;
          const revoke = (items: string[]) => items.forEach((url) => URL.revokeObjectURL(url));
          const show = () => {
            const url = urls[active];
            if (preview !== null && url !== undefined)
              preview.src = `${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
            if (download !== null) {
              if (url === undefined) download.removeAttribute("href");
              else {
                download.href = url;
                download.download = `${names[active] ?? "example"}.pdf`;
              }
            }
          };
          const generate = (marked: boolean) => {
            const current = ++generation;
            controller?.abort();
            controller = new AbortController();
            const signal = controller.signal;
            if (status !== null) status.textContent = "Preparando exemplos…";
            if (run !== null) run.disabled = true;
            if (reset !== null) reset.disabled = true;
            const program = Effect.promise(() =>
              Promise.all([
                import("@signature-kit/pdf/stamp"),
                import("@signature-kit/pdf-core/browser"),
              ]),
            ).pipe(
              Effect.flatMap(([{ createIllustrativePdf }, { pdfCoreBrowserLayer }]) =>
                Effect.forEach(variants, (variant, index) =>
                  createIllustrativePdf({
                    title: names[index] ?? "Example",
                    body: "Documento demonstrativo. Este conteúdo é apenas um exemplo visual.",
                    variant,
                    marked,
                    markLabel: "MARCA ILUSTRATIVA",
                  }),
                ).pipe(Effect.provide(pdfCoreBrowserLayer)),
              ),
            );
            Effect.runPromiseExitWith(context)(program, { signal }).then(
              (result) => {
                if (closed || current !== generation) return;
                if (Exit.isFailure(result)) {
                  if (status !== null) status.textContent = "Não foi possível gerar os exemplos.";
                } else {
                  const old = urls;
                  urls = result.value.map((bytes) =>
                    URL.createObjectURL(
                      new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
                    ),
                  );
                  show();
                  revoke(old);
                  if (status !== null)
                    status.textContent = marked
                      ? "Marcas ilustrativas aplicadas. Não são assinaturas digitais."
                      : "Exemplos prontos, sem assinatura digital.";
                }
                if (run !== null) run.disabled = false;
                if (reset !== null) reset.disabled = false;
              },
              () => {
                if (closed || current !== generation) return;
                if (status !== null) status.textContent = "Não foi possível gerar os exemplos.";
                if (run !== null) run.disabled = false;
                if (reset !== null) reset.disabled = false;
              },
            );
          };
          let request = element.getAttribute("data-request");
          const observer = new MutationObserver(() => {
            active = Number(element.getAttribute("data-active") ?? "0");
            const nextRequest = element.getAttribute("data-request");
            if (nextRequest !== request) {
              request = nextRequest;
              generate(element.getAttribute("data-marked") === "true");
            }
            show();
          });
          observer.observe(element, {
            attributes: true,
            attributeFilter: ["data-active", "data-request", "data-marked"],
          });
          generate(element.getAttribute("data-marked") === "true");
          return () => {
            closed = true;
            generation++;
            controller?.abort();
            observer.disconnect();
            revoke(urls);
          };
        }),
        (dispose) => Effect.sync(dispose),
      );
      return DemoMounted.make({});
    }),
});

export const HomeDemoModel = Schema.Struct({
  active: Schema.Int,
  request: Schema.Int,
  marked: Schema.Boolean,
  documents: Tabs.Model,
});
export type HomeDemoModel = typeof HomeDemoModel.Type;
export const Message = defineMessageUnion({
  DemoMounted: {},
  PreviousRequested: {},
  NextRequested: {},
  MarkRequested: {},
  ResetRequested: {},
  DownloadRequested: {},
  AnalyticsRecorded: {},
  GotDemoTabsMessage: { message: Tabs.Message },
});
export type Message = typeof Message.Type;
const RecordDemoEvent = Command.define("RecordDemoEvent", {
  args: { action: Schema.Literals(["run", "reset", "download"]), index: Schema.Int },
  messages: [Message.AnalyticsRecorded],
  execute: ({ action, index }) =>
    Effect.sync(() => {
      if (action === "run") captureDocsEvent("auto_sign_demo_started", { document_count: 4 });
      if (action === "reset") captureDocsEvent("auto_sign_demo_reset", { document_count: 4 });
      if (action === "download")
        captureDocsEvent("auto_sign_demo_downloaded", {
          document_id: ["doc-contrato", "doc-aditivo", "doc-procuracao", "doc-adesao"][index],
          signed: false,
        });
      return Message.AnalyticsRecorded();
    }),
});
export const homeDemoInit = (): HomeDemoModel => ({
  active: 0,
  request: 0,
  marked: false,
  documents: Tabs.init({ id: "home-demo-documents" }),
});
const foldDemoTabs = Update.foldChild({
  update: DemoTabs.update,
  read: (model: HomeDemoModel) => Option.some(model.documents),
  write: (model, documents) => ({ ...model, documents }),
  toParentMessage: (message) => Message.GotDemoTabsMessage({ message }),
  foldOutMessage: Tabs.OutMessage.match({
    Selected:
      ({ value }) =>
      (model: HomeDemoModel) => {
        const decoded = Schema.decodeUnknownOption(DemoIndex)(value);
        return Option.match(decoded, {
          onNone: () => ({ model }),
          onSome: (index) => ({ model: { ...model, active: Number(index) } }),
        });
      },
  }),
});
export const homeDemoUpdate = (model: HomeDemoModel, message: Message) =>
  Message.match(message, {
    GotDemoTabsMessage: ({ message }) => ({ model: foldDemoTabs(model, message).model }),
    DemoMounted: () => ({ model }),
    AnalyticsRecorded: () => ({ model }),
    PreviousRequested: () => ({ model: { ...model, active: (model.active + 3) % 4 } }),
    NextRequested: () => ({ model: { ...model, active: (model.active + 1) % 4 } }),
    MarkRequested: () => ({
      model: { ...model, request: model.request + 1, marked: true },
      commands: [RecordDemoEvent({ action: "run", index: model.active })],
    }),
    ResetRequested: () => ({
      model: { ...model, request: model.request + 1, marked: false },
      commands: [RecordDemoEvent({ action: "reset", index: model.active })],
    }),
    DownloadRequested: () => ({
      model,
      commands: [RecordDemoEvent({ action: "download", index: model.active })],
    }),
  });

export const homeDemoView = defineView<HomeDemoModel, Message>((model, h) => {
  const names = ["Contrato de serviços", "Aditivo contratual", "Procuração", "Termo de adesão"];
  return h.div(
    [
      ...sx(h, "home-demo", landing.demo),
      h.Attribute("data-active", String(model.active)),
      h.Attribute("data-request", String(model.request)),
      h.Attribute("data-marked", String(model.marked)),
      h.OnMount(Mount.mapMessage(DemoMount(), () => Message.DemoMounted())),
    ],
    [
      h.p(
        [...sx(h, landing.demoNote)],
        ["Exemplo visual ilustrativo: não é assinatura digital e não usa certificado."],
      ),
      h.submodel({
        slotId: "home-demo-documents",
        model: model.documents,
        view: DemoTabs.view,
        viewInputs: {
          tabs: demoIndexes,
          selectedValue: Option.getOrElse(
            Schema.decodeUnknownOption(DemoIndex)(String(model.active)),
            (): typeof DemoIndex.Type => "0",
          ),
          ariaLabel: "Documentos de exemplo",
          panelMount: "ActiveOnly",
          toView: ({ tablist, tabs }) =>
            h.div(
              [...tablist, ...sx(h, "home-demo-controls", landing.tabs, landing.toolbar)],
              tabs.map((tab) =>
                h.button(
                  [
                    ...tab.tab,
                    h.Attribute("data-demo-index", tab.value),
                    ...sx(h, landing.tab, tab.isActive && landing.tabOn),
                  ],
                  [names[tab.index] ?? ""],
                ),
              ),
            ),
        },
        toParentMessage: (message) => Message.GotDemoTabsMessage({ message }),
      }),
      h.div(
        [
          ...sx(h, landing.stage),
          h.Id(`home-demo-documents-panel-${String(model.active)}`),
          h.Role("tabpanel"),
          h.AriaLabelledBy(`home-demo-documents-tab-${String(model.active)}`),
        ],
        [
          h.iframe([
            h.Attribute("data-demo-preview", ""),
            ...sx(h, landing.preview),
            h.Attribute("title", "Prévia do exemplo"),
          ]),
        ],
      ),
      h.div(
        [...sx(h, "home-demo-controls", landing.toolbar)],
        [
          Button.view(
            {
              onClick: Message.MarkRequested(),
              toView: ({ button }) =>
                h.button(
                  [...button, ...sx(h, shell.primary), h.Attribute("data-demo-run", "")],
                  ["Aplicar marcas ilustrativas"],
                ),
            },
            h,
          ),
          Button.view(
            {
              onClick: Message.ResetRequested(),
              toView: ({ button }) =>
                h.button(
                  [...button, ...sx(h, shell.ghost), h.Attribute("data-demo-reset", "")],
                  ["Reiniciar"],
                ),
            },
            h,
          ),
          Button.view(
            {
              onClick: Message.PreviousRequested(),
              toView: ({ button }) =>
                h.button(
                  [
                    ...button,
                    ...sx(h, shell.ghost),
                    h.Attribute("data-demo-previous", ""),
                    h.AriaLabel("Documento anterior"),
                  ],
                  ["←"],
                ),
            },
            h,
          ),
          Button.view(
            {
              onClick: Message.NextRequested(),
              toView: ({ button }) =>
                h.button(
                  [
                    ...button,
                    ...sx(h, shell.ghost),
                    h.Attribute("data-demo-next", ""),
                    h.AriaLabel("Próximo documento"),
                  ],
                  ["→"],
                ),
            },
            h,
          ),
          h.a(
            [
              ...sx(h, landing.link),
              h.Attribute("data-demo-download", ""),
              h.OnClick(Message.DownloadRequested()),
            ],
            ["Baixar exemplo"],
          ),
          h.p(
            [...sx(h, landing.status), h.Attribute("data-demo-label", "")],
            [`${names[model.active] ?? ""} · ${model.active + 1} / 4`],
          ),
        ],
      ),
      h.p(
        [h.Attribute("data-demo-status", ""), h.Role("status"), ...sx(h, landing.status)],
        ["Preparando exemplos…"],
      ),
    ],
  );
});
