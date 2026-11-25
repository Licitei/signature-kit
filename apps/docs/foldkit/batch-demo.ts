import { LocalClient, localClientLayer } from "@signature-kit/browser/client";
import { LocalError, LocalErrorCode, localErrorMessages } from "@signature-kit/engine/rpc";
import type { BatchPrepareInput, BatchSnapshot } from "@signature-kit/engine/rpc";
import { contractTemplate } from "@signature-kit/engine/templates";
import { Effect, Option, Redacted, Schema, Scope, Stream } from "effect";
import { Dom } from "foldkit";
import * as Mount from "foldkit/mount";
import type { HtmlBuilder } from "foldkit/html";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";

const DemoItem = Schema.Struct({
  itemId: Schema.String,
  url: Schema.optional(Schema.String),
  reason: Schema.optional(LocalErrorCode),
});
export const BatchDemoState = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("input", {}),
  Schema.TaggedStruct("review", { items: Schema.Array(DemoItem) }),
  Schema.TaggedStruct("finished", { items: Schema.Array(DemoItem) }),
  Schema.TaggedStruct("error", { detail: Schema.String }),
]);
const BatchDemoChanged = Schema.TaggedStruct("BatchDemoChanged", { batch: BatchDemoState });
type DemoState = typeof BatchDemoState.Type;

const submit = (element: Element, phase: string) =>
  Dom.streamFromEventFilterMapPreventDefault({
    target: element,
    type: "submit",
    filterMapEvent: (event) =>
      event.target === element.querySelector(`form[data-phase="${phase}"]`)
        ? Option.some(event)
        : Option.none(),
  }).pipe(Stream.take(1));

export const BatchDemoMount = Mount.defineStream("BatchDemoMount", {
  messages: [BatchDemoChanged],
  execute: ({ element }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* LocalClient;
        const scope = yield* Effect.scope;
        const itemLinks = (batch: BatchSnapshot) =>
          Effect.forEach(batch.items, (item) =>
            Effect.gen(function* () {
              const revision = item.receipt?.signedRevision ?? item.preparation?.previewRevision;
              if (revision === undefined) return { itemId: item.itemId, reason: item.reason };
              const bytes = yield* client.exportDocument(revision.handle);
              const url = yield* Scope.provide(
                Effect.acquireRelease(
                  Effect.sync(() =>
                    URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })),
                  ),
                  (url) => Effect.sync(() => URL.revokeObjectURL(url)),
                ),
                scope,
              );
              return { itemId: item.itemId, url };
            }),
          );
        const prepare = Effect.gen(function* () {
          const input = element.querySelector<HTMLInputElement>("#batch-certificate");
          const password = element.querySelector<HTMLInputElement>("#batch-password");
          const file = input?.files?.[0];
          if (file === undefined || password === null)
            return yield* new LocalError({ code: "invalidPkcs12" });
          const secret = Redacted.make(password.value);
          password.value = "";
          const pfx = yield* Effect.tryPromise({
            try: async () => Redacted.make(new Uint8Array(await file.arrayBuffer())),
            catch: () => new LocalError({ code: "invalidPkcs12" }),
          });
          const session = yield* client.openA1({ pfx, password: secret });
          const openContract = (itemId: string) =>
            Effect.acquireRelease(client.composePdf({ document: contractTemplate() }), (revision) =>
              client.releaseDocument(revision.handle).pipe(Effect.ignore),
            ).pipe(Effect.map((revision) => ({ itemId, revision })));
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* openContract("1");
              const second = yield* openContract("2");
              const third = yield* openContract("3");
              const documents: BatchPrepareInput["documents"] = [first, second, third];
              return yield* client.prepareBatch({
                documents,
                session,
                template: {
                  field: { kind: "existing", name: "assinatura-contratante" },
                  appearance: { kind: "visible" },
                  policy: "cades",
                },
              });
            }),
          );
        });
        return Stream.concat(
          Stream.succeed(BatchDemoChanged.make({ batch: { _tag: "input" } })),
          submit(element, "prepare").pipe(
            Stream.mapEffect(() => prepare),
            Stream.flatMap((batch) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const ready = yield* itemLinks(batch);
                  const finish = Effect.gen(function* () {
                    const checked = new Set(
                      Array.from(
                        element.querySelectorAll<HTMLInputElement>(
                          "input[name=batch-item]:checked",
                        ),
                        ({ value }) => value,
                      ),
                    );
                    const [first, ...rest] = batch.items.flatMap(({ itemId, preparation }) =>
                      preparation !== undefined && checked.has(itemId)
                        ? [{ itemId, preparationId: preparation.preparationId }]
                        : [],
                    );
                    if (first === undefined)
                      return yield* new LocalError({ code: "batchSelection" });
                    yield* client.confirmBatch(batch.batchId, [first, ...rest]);
                    yield* client.batchEvents(batch.batchId).pipe(Stream.runDrain);
                    const result = yield* client.batchSnapshot(batch.batchId);
                    if (result.reason !== undefined)
                      return yield* new LocalError({ code: result.reason });
                    const items = yield* itemLinks(result);
                    yield* client.releaseBatch(batch.batchId);
                    yield* client.closeA1();
                    return BatchDemoChanged.make({ batch: { _tag: "finished", items } });
                  });
                  return Stream.concat(
                    Stream.succeed(
                      BatchDemoChanged.make({ batch: { _tag: "review", items: ready } }),
                    ),
                    submit(element, "confirm").pipe(Stream.mapEffect(() => finish)),
                  );
                }),
              ),
            ),
          ),
        ).pipe(Stream.concat(Stream.never));
      }),
    ).pipe(
      Stream.provide(
        localClientLayer(
          () => new Worker(new URL("./compose-worker.ts", import.meta.url), { type: "module" }),
        ),
      ),
      Stream.catch((error) =>
        Stream.succeed(
          BatchDemoChanged.make({
            batch: { _tag: "error", detail: localErrorMessages[error.code] },
          }),
        ),
      ),
    ),
});

export const batchDemoView = <Message>(
  h: HtmlBuilder<Message>,
  batch: DemoState,
  pt: boolean,
  mount: Parameters<HtmlBuilder<Message>["OnMount"]>[0],
  submitted: Message,
) =>
  h.div(
    [h.OnMount(mount)],
    [
      h.form(
        [
          h.OnSubmit(submitted),
          h.Attribute("data-phase", "prepare"),
          h.Hidden(batch._tag !== "input"),
        ],
        [
          h.p(
            [],
            [h.label([h.For("batch-certificate")], [pt ? "Certificado A1" : "A1 certificate"])],
          ),
          h.p(
            [],
            [
              h.input([
                h.Id("batch-certificate"),
                h.Type("file"),
                h.Attribute("accept", ".p12,.pfx"),
                h.Required(true),
              ]),
            ],
          ),
          h.p(
            [],
            [
              h.label(
                [h.For("batch-password")],
                [pt ? "Senha do certificado" : "Certificate password"],
              ),
            ],
          ),
          h.p([], [h.input([h.Id("batch-password"), h.Type("password"), h.Required(true)])]),
          h.button(
            [h.Type("submit"), ...sx(h, shell.pill)],
            [pt ? "Preparar três contratos" : "Prepare three contracts"],
          ),
        ],
      ),
      ...(batch._tag === "review" || batch._tag === "finished"
        ? [
            h.form(
              [h.OnSubmit(submitted), h.Attribute("data-phase", "confirm")],
              [
                h.ul(
                  [],
                  batch.items.map((item) =>
                    h.li(
                      [],
                      [
                        ...(batch._tag === "review" && item.url !== undefined
                          ? [
                              h.input([
                                h.Id(`batch-item-${item.itemId}`),
                                h.Type("checkbox"),
                                h.Name("batch-item"),
                                h.Value(item.itemId),
                                h.Checked(true),
                              ]),
                              h.label(
                                [h.For(`batch-item-${item.itemId}`)],
                                [pt ? "Incluir " : "Include "],
                              ),
                            ]
                          : []),
                        item.url === undefined
                          ? h.span(
                              [],
                              [
                                `#${item.itemId} ${item.reason === undefined ? "" : localErrorMessages[item.reason]}`,
                              ],
                            )
                          : h.a(
                              [
                                h.Href(item.url),
                                ...(batch._tag === "review"
                                  ? [
                                      h.Attribute("target", "_blank"),
                                      h.Attribute("rel", "noopener"),
                                    ]
                                  : [h.Attribute("download", `contract-${item.itemId}.pdf`)]),
                              ],
                              [
                                `${batch._tag === "review" ? (pt ? "Revisar" : "Review") : pt ? "Baixar" : "Download"} PDF #${item.itemId}`,
                              ],
                            ),
                      ],
                    ),
                  ),
                ),
                ...(batch._tag === "review" && batch.items.some((item) => item.url !== undefined)
                  ? [
                      h.button(
                        [h.Type("submit"), ...sx(h, shell.pill)],
                        [pt ? "Assinar selecionados" : "Sign selected"],
                      ),
                    ]
                  : []),
              ],
            ),
          ]
        : []),
      ...(batch._tag === "error" ? [h.p([h.Attribute("role", "alert")], [batch.detail])] : []),
    ],
  );
