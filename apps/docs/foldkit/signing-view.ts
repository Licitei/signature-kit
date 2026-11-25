import * as Domain from "@alchemy.run/domain";
import {
  Button,
  Disclosure,
  Fieldset,
  FileDrop,
  Input,
  Progress,
  RadioGroup,
  Switch,
} from "@foldkit/ui";
import type { A1CertificateProfile } from "@signature-kit/a1/config";
import { isSafePdfStampPng } from "@signature-kit/pdf/stamp";
import { errorMessage } from "@signature-kit/i18n";
import {
  SignatureKitError,
  SignatureKitErrorCodeValue,
  signatureKitErrorMessages,
} from "@signature-kit/signatures";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { loadPdfSignatureDocument, readPdfBlobBytes } from "@signature-kit/pdf/workflow";
import { createPdfSignatureBuilderStateFromTemplate } from "@signature-kit/pdf/builder";
import {
  createPdfSignatureBuilderStore,
  placePdfSignatureFieldsBatch,
} from "@signature-kit/pdf/builder-store";
import {
  pdfHandwritingBrowserLayer,
  PdfHandwriting,
  pdfPageRendererWorkerLayer,
  renderPdfPagesBrowser,
} from "@signature-kit/pdf/render-browser";
import type {
  PdfPrepareAndSignInput,
  PdfSignatureBadge,
  PdfSignatureDocument,
  PdfSignatureFieldDraft,
  PdfSignatureRect,
} from "@signature-kit/pdf/config";
import {
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
  pdfErrorMessages,
} from "@signature-kit/pdf/config";
import { cmsErrorMessages } from "@signature-kit/cms/config";
import { SigningModel } from "@signature-kit/signing-domain";
import * as stylex from "@stylexjs/stylex";
import { Effect, Fiber, Layer, Option, Result, Schema } from "effect";
import { Update } from "foldkit";
import type { Attribute, Html } from "foldkit/html";
import { defineView } from "foldkit/submodel";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import { captureDocsEvent } from "../lib/posthog/client";
import { makeSigningBatch, makeSigningWorkerSession } from "./signing-runtime";
import { shell } from "./styles/shell";
import { signing } from "./styles/signing";
import { sx } from "./styles/sx";
import { icon } from "./icons";
import type { IconName } from "./icons";

export const SigningMounted = Schema.TaggedStruct("SigningMounted", {});
const pageRendererLayer = () =>
  pdfPageRendererWorkerLayer(
    {},
    () => new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" }),
  );
const cleanups = new Set<() => void>();
if (import.meta.hot !== undefined)
  import.meta.hot.dispose(() => {
    for (const cleanup of cleanups) cleanup();
  });

const SigningMount = Mount.define("SigningMount", {
  messages: [SigningMounted],
  execute: ({ element }) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        SigningModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
      );
      const batch = yield* makeSigningBatch.pipe(Effect.provideContext(context));
      const runtimeContext = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const form = element.querySelector("form");
          const pfx = element.querySelector<HTMLInputElement>("[name=pfx]");
          const password = element.querySelector<HTMLInputElement>("[name=password]");
          const pdf = element.querySelector<HTMLInputElement>("[name=pdf]");
          const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]");
          const status = element.querySelector<HTMLElement>("[data-status]");
          const progress = element.querySelector<HTMLElement>("[data-progress]");
          const downloads = element.querySelector<HTMLElement>("[data-downloads]");
          const preview = element.querySelector<HTMLElement>("[data-preview]");
          const previous = element.querySelector<HTMLButtonElement>("[data-previous]");
          const next = element.querySelector<HTMLButtonElement>("[data-next]");
          const auto = element.querySelector<HTMLButtonElement>("[data-auto]");
          const rubric = element.querySelector<HTMLButtonElement>("[data-rubric]");
          const title = element.querySelector<HTMLInputElement>("[name=stampTitle]");
          const color = element.querySelector<HTMLInputElement>("[name=stampColor]");
          const identity = element.querySelector<HTMLButtonElement>("[data-stamp-identity]");
          const date = element.querySelector<HTMLButtonElement>("[data-stamp-date]");
          const logo = element.querySelector<HTMLInputElement>("[name=stampLogo]");
          const removeLogo = element.querySelector<HTMLButtonElement>("[data-remove-logo]");
          const loadIdentity = element.querySelector<HTMLButtonElement>("[data-load-identity]");
          const identityStatus = element.querySelector<HTMLElement>("[data-identity]");
          const rubricSource = element.querySelector<HTMLInputElement>("[name=rubricSource]");
          const bridgeDrop = (input: HTMLInputElement | null) => {
            const zone = input?.closest("label");
            if (input == null || zone == null) return () => undefined;
            const onDrop = (event: DragEvent) => {
              const dropped = event.dataTransfer?.files;
              if (dropped === undefined || dropped.length === 0) return;
              const current = input.files;
              const same =
                current !== null &&
                current.length === dropped.length &&
                Array.from(dropped).every((file, index) => file === current.item(index));
              if (same) return;
              const transfer = new DataTransfer();
              for (const file of Array.from(dropped)) transfer.items.add(file);
              input.files = transfer.files;
              input.dispatchEvent(new Event("change", { bubbles: true }));
            };
            zone.addEventListener("drop", onDrop);
            return () => zone.removeEventListener("drop", onDrop);
          };
          const unbridgePfx = bridgeDrop(pfx);
          const unbridgePdf = bridgeDrop(pdf);
          const unbridgeLogo = bridgeDrop(logo);
          const rubricText = element.querySelector<HTMLInputElement>("[name=rubricText]");
          const locale = "pt-BR";
          const message = (error: { readonly _tag: string; readonly code?: string }) =>
            error._tag === "RpcClientError"
              ? "Não foi possível comunicar com o serviço de assinatura. Tente novamente."
              : errorMessage(error, {
                  locale,
                  catalogs: [signatureKitErrorMessages, pdfErrorMessages, cmsErrorMessages],
                });
          let closed = false;
          let controlsLocked = false;
          let cancelling = false;
          let batchId = 0;
          let active: Fiber.Fiber<unknown, unknown> | undefined;
          let session: Effect.Success<typeof makeSigningWorkerSession> | undefined;
          const fibers = new Set<Fiber.Fiber<unknown, unknown>>();
          const urls = new Set<string>();
          const previewUrls = new Set<string>();
          const visualUrls = new Set<string>();
          let profile: A1CertificateProfile | undefined;
          let profileFile: File | undefined;
          let profileDate = "";
          let visualGeneration = 0;
          let visualFiber: Fiber.Fiber<unknown, unknown> | undefined;
          let visualAppearance: Pick<PdfPrepareAndSignInput, "badge" | "rubric"> | undefined;
          let logoBytes: Uint8Array | undefined;
          let logoFile: File | undefined;
          let logoGeneration = 0;
          let logoLoading = false;
          let previewGeneration = 0;
          let previewFiber: Fiber.Fiber<unknown, unknown> | undefined;
          let selectedPage = 0;
          let selectedDocument = 0;
          let entries: Array<{
            file: File;
            document: PdfSignatureDocument;
            images: ReadonlyArray<string>;
            visualImages?: ReadonlyArray<string>;
            rect: PdfSignatureRect | undefined;
          }> = [];
          const clearPreview = () => {
            for (const url of previewUrls) URL.revokeObjectURL(url);
            previewUrls.clear();
            preview?.replaceChildren();
            entries = [];
          };
          const drawPreview = () => {
            if (preview === null) return;
            const focused = preview.querySelector(".signing-page") === document.activeElement;
            preview.replaceChildren();
            const entry = entries[selectedDocument];
            const page = entry?.document.pages[selectedPage];
            const image = entry?.visualImages?.[selectedPage] ?? entry?.images[selectedPage];
            if (entry === undefined || page === undefined || image === undefined) return;
            const select = document.createElement("select");
            select.setAttribute("aria-label", "Documento");
            entries.forEach((item, index) => {
              const option = document.createElement("option");
              option.value = String(index);
              option.textContent = item.file.name;
              option.selected = index === selectedDocument;
              select.append(option);
            });
            select.disabled = controlsLocked || cancelling;
            select.addEventListener("change", () => {
              if (controlsLocked || cancelling) return;
              selectedDocument = Number(select.value);
              selectedPage = entries[selectedDocument]?.rect?.pageIndex ?? 0;
              drawPreview();
            });
            const bar = document.createElement("div");
            bar.className = stylex.props(signing.previewBar).className ?? "";
            const label = document.createElement("p");
            label.className = stylex.props(signing.previewLabel).className ?? "";
            label.textContent = `${"Página"} ${selectedPage + 1} / ${entry.document.pages.length}`;
            const canvas = document.createElement("div");
            canvas.className = `signing-page ${stylex.props(signing.documentPage).className ?? ""}`;
            canvas.tabIndex = 0;
            canvas.setAttribute("role", "button");
            canvas.setAttribute(
              "aria-label",
              `Posicionar assinatura — ${label.textContent}. Use Enter ou espaço para posicionar e as setas para mover.`,
            );
            canvas.setAttribute("aria-disabled", String(controlsLocked || cancelling));
            const img = document.createElement("img");
            img.src = image;
            img.alt = `${entry.file.name} — ${label.textContent}`;
            img.className = stylex.props(signing.pageImage).className ?? "";
            canvas.append(img);
            if (entry.rect !== undefined && entry.rect.pageIndex === selectedPage) {
              const marker = document.createElement("div");
              marker.className = `signing-rectangle ${stylex.props(signing.rectangle).className ?? ""}`;
              marker.style.left = `${(entry.rect.x / page.width) * 100}%`;
              marker.style.top = `${(entry.rect.y / page.height) * 100}%`;
              marker.style.width = `${(entry.rect.width / page.width) * 100}%`;
              marker.style.height = `${(entry.rect.height / page.height) * 100}%`;
              marker.setAttribute("aria-label", "Posição da assinatura");
              canvas.append(marker);
            }
            const place = (x: number, y: number) => {
              if (controlsLocked || cancelling) return;
              const width = Math.min(320, page.width);
              const height = Math.min(128, page.height);
              entry.rect = {
                pageIndex: selectedPage,
                width,
                height,
                x: Math.max(0, Math.min(page.width - width, x * page.width - width / 2)),
                y: Math.max(0, Math.min(page.height - height, y * page.height - height / 2)),
              };
              captureDocsEvent("pdf_signer_signature_placed", {
                document_count: entries.length,
                placed_count: entries.filter((item) => item.rect !== undefined).length,
              });
              refreshVisual();
              drawPreview();
            };
            canvas.addEventListener("click", (event) => {
              const bounds = canvas.getBoundingClientRect();
              place(
                (event.clientX - bounds.left) / bounds.width,
                (event.clientY - bounds.top) / bounds.height,
              );
            });
            canvas.addEventListener("keydown", (event) => {
              if (controlsLocked || cancelling) return;
              const rect = entry.rect?.pageIndex === selectedPage ? entry.rect : undefined;
              const x = rect === undefined ? 0.5 : (rect.x + rect.width / 2) / page.width;
              const y = rect === undefined ? 0.5 : (rect.y + rect.height / 2) / page.height;
              switch (event.key) {
                case "Enter":
                case " ":
                  event.preventDefault();
                  place(x, y);
                  break;
                case "ArrowLeft":
                case "ArrowRight":
                  event.preventDefault();
                  place(x + (event.key === "ArrowLeft" ? -0.02 : 0.02), y);
                  break;
                case "ArrowUp":
                case "ArrowDown":
                  event.preventDefault();
                  place(x, y + (event.key === "ArrowUp" ? -0.02 : 0.02));
                  break;
              }
            });
            const remove = document.createElement("button");
            remove.type = "button";
            remove.disabled = controlsLocked || cancelling;
            remove.textContent = "Remover documento";
            remove.addEventListener("click", () => {
              if (controlsLocked || cancelling || pdf === null) return;
              const remaining = new DataTransfer();
              Array.from(pdf.files ?? []).forEach((file, index) => {
                if (index !== selectedDocument) remaining.items.add(file);
              });
              pdf.files = remaining.files;
              captureDocsEvent("pdf_signer_document_removed", {
                remaining_count: remaining.files.length,
              });
              loadPreview();
            });
            select.className = stylex.props(signing.control, signing.previewSelect).className ?? "";
            remove.className = stylex.props(shell.ghost).className ?? "";
            bar.append(select, label, remove);
            preview.append(bar, canvas);
            if (focused) canvas.focus();
          };
          const say = (text: string) => {
            if (!closed && status !== null) status.textContent = text;
          };
          const run = (effect: Effect.Effect<unknown, unknown>) => {
            const fiber = Effect.runForkWith(runtimeContext)(effect);
            fibers.add(fiber);
            Effect.runForkWith(runtimeContext)(
              Fiber.await(fiber).pipe(Effect.map(() => fibers.delete(fiber))),
            );
            return fiber;
          };
          const decodePreviewImage = (url: string) =>
            Effect.scoped(
              Effect.gen(function* () {
                const image = yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    const element = new Image();
                    element.src = url;
                    return element;
                  }),
                  (element) =>
                    Effect.sync(() => {
                      element.removeAttribute("src");
                    }),
                );
                yield* Effect.tryPromise({
                  try: () => image.decode(),
                  catch: () =>
                    new PdfError({
                      code: PdfErrorCodeValue.pdfLoadFailed,
                      retryable: false,
                      operation: PdfOperationValue.parse,
                      reason: "PDF preview image could not be decoded.",
                    }),
                });
              }),
            );
          const loadPreview = () => {
            if (controlsLocked || cancelling) return;
            invalidateVisual();
            const generation = ++previewGeneration;
            if (previewFiber !== undefined) run(Fiber.interrupt(previewFiber));
            const previousEntries = entries;
            clearPreview();
            selectedDocument = 0;
            selectedPage = 0;
            const files = pdf?.files == null ? [] : Array.from(pdf.files);
            captureDocsEvent("pdf_signer_pdfs_selected", { document_count: files.length });
            if (files.length === 0 || files.length > 100) return;
            previewFiber = run(
              Effect.scoped(
                Effect.gen(function* () {
                  const staged = yield* Effect.acquireRelease(
                    Effect.sync(() => ({ urls: new Set<string>(), accepted: false })),
                    (state) =>
                      Effect.sync(() => {
                        if (!state.accepted) for (const url of state.urls) URL.revokeObjectURL(url);
                      }),
                  );
                  const loaded = yield* Effect.forEach(files, (file, index) =>
                    Effect.gen(function* () {
                      const bytes = yield* readPdfBlobBytes(file);
                      const document = yield* loadPdfSignatureDocument({
                        id: String(index),
                        name: file.name,
                        pdf: bytes,
                      }).pipe(Effect.provide(pdfCoreBrowserLayer));
                      const pages = yield* renderPdfPagesBrowser(bytes, {
                        pageIndexes: document.pages.map((_, pageIndex) => pageIndex),
                      });
                      const images = yield* Effect.forEach(pages, (page) =>
                        Effect.gen(function* () {
                          const url = yield* Effect.sync(() => {
                            const created = URL.createObjectURL(page.image);
                            staged.urls.add(created);
                            return created;
                          });
                          yield* decodePreviewImage(url);
                          return url;
                        }),
                      );
                      return { file, document, images };
                    }),
                  ).pipe(Effect.provide(Layer.merge(pdfCoreBrowserLayer, pageRendererLayer())));
                  yield* Effect.sync(() => {
                    if (closed || generation !== previewGeneration) return;
                    entries = loaded.map((item) => ({
                      ...item,
                      rect: previousEntries.find((entry) => entry.file === item.file)?.rect,
                    }));
                    for (const url of staged.urls) previewUrls.add(url);
                    staged.accepted = true;
                    captureDocsEvent("pdf_signer_pdfs_loaded", {
                      failed_count: 0,
                      loaded_count: entries.length,
                      selected_count: files.length,
                    });
                    selectedPage = entries[0]?.rect?.pageIndex ?? 0;
                    refreshVisual();
                    drawPreview();
                    if (
                      element.getAttribute("data-signing-mode") === "rapida" &&
                      entries.some((entry) => entry.rect === undefined)
                    )
                      placeAutomatically();
                  });
                }),
              ).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    if (generation === previewGeneration) {
                      captureDocsEvent("pdf_signer_pdfs_loaded", {
                        failed_count: files.length,
                        loaded_count: 0,
                        selected_count: files.length,
                      });
                      say(message(error));
                    }
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (generation === previewGeneration) previewFiber = undefined;
                  }),
                ),
              ),
            );
          };
          const showPrevious = () => {
            if (controlsLocked || cancelling) return;
            selectedPage = Math.max(0, selectedPage - 1);
            drawPreview();
          };
          const showNext = () => {
            if (controlsLocked || cancelling) return;
            selectedPage = Math.min(
              (entries[selectedDocument]?.document.pages.length ?? 1) - 1,
              selectedPage + 1,
            );
            drawPreview();
          };
          const certificateSelected = () => {
            if (controlsLocked || cancelling) return;
            profile = undefined;
            profileFile = undefined;
            if (identityStatus !== null) identityStatus.textContent = "";
            invalidateVisual();
            drawPreview();
            if (pfx?.files?.item(0) != null) captureDocsEvent("pdf_signer_certificate_selected");
          };
          const placeAutomatically = () => {
            if (controlsLocked || cancelling || entries.length === 0) return;
            const current = entries;
            captureDocsEvent("pdf_signer_auto_place_started", {
              document_count: current.length,
              unplaced_count: current.filter((entry) => entry.rect === undefined).length,
            });
            setLocked(true);
            run(
              Effect.forEach(current, (entry, index) =>
                Effect.gen(function* () {
                  const page = entry.document.pages[entry.document.pages.length - 1];
                  if (page === undefined) return undefined;
                  const draft: PdfSignatureFieldDraft = {
                    id: "signature",
                    type: "signature",
                    roleId: "signer",
                    width: Math.min(320, page.width),
                    height: Math.min(128, page.height),
                    required: true,
                  };
                  const id = String(index);
                  const state = yield* createPdfSignatureBuilderStateFromTemplate({
                    template: {
                      id: "signing-view",
                      name: "Signing",
                      documents: [entry.document],
                      roles: [
                        {
                          id: "signer",
                          label: "Signer",
                          email: "signer@example.com",
                          required: true,
                        },
                      ],
                    },
                    draft,
                  });
                  return {
                    id,
                    documentId: entry.document.id,
                    store: createPdfSignatureBuilderStore(state),
                    draft,
                  };
                }),
              ).pipe(
                Effect.flatMap((queue) =>
                  placePdfSignatureFieldsBatch(queue.filter((item) => item !== undefined)),
                ),
                Effect.tap((results) =>
                  Effect.sync(() => {
                    if (closed || entries !== current) return;
                    for (const result of results) {
                      const entry = current[Number(result.id)];
                      if (result.ok && entry !== undefined) entry.rect = result.field.rect;
                    }
                    captureDocsEvent("pdf_signer_auto_place_completed", {
                      placed_count: current.filter((entry) => entry.rect !== undefined).length,
                      total_count: current.length,
                    });
                    selectedPage = current[selectedDocument]?.rect?.pageIndex ?? 0;
                    refreshVisual();
                    drawPreview();
                  }),
                ),
                Effect.catch((error) => Effect.sync(() => say(message(error)))),
                Effect.ensuring(
                  Effect.sync(() => {
                    setLocked(false);
                  }),
                ),
              ),
            );
          };
          const loadLogo = () => {
            if (controlsLocked || cancelling) return;
            const generation = ++logoGeneration;
            invalidateVisual();
            drawPreview();
            logoBytes = undefined;
            logoFile = undefined;
            const file = logo?.files?.item(0);
            if (file == null) {
              logoLoading = false;
              refreshVisual();
              drawPreview();
              return;
            }
            logoLoading = true;
            run(
              Effect.tryPromise({
                try: () => file.arrayBuffer(),
                catch: () =>
                  new PdfError({
                    code: PdfErrorCodeValue.stampFailed,
                    retryable: false,
                    operation: PdfOperationValue.stamp,
                    reason: "Logo PNG could not be read.",
                  }),
              }).pipe(
                Effect.map((bytes) => new Uint8Array(bytes)),
                Effect.flatMap((bytes) =>
                  isSafePdfStampPng(bytes).pipe(
                    Effect.map((valid) => ({ bytes, valid })),
                    Effect.provide(pdfCoreBrowserLayer),
                  ),
                ),
                Effect.tap(({ bytes, valid }) =>
                  Effect.sync(() => {
                    if (generation !== logoGeneration || closed) return;
                    logoBytes = valid ? bytes : undefined;
                    logoFile = valid ? file : undefined;
                    if (!valid) say("Selecione um PNG válido.");
                  }),
                ),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    if (generation === logoGeneration) say(message(error));
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (generation === logoGeneration) {
                      logoLoading = false;
                      if (logoBytes !== undefined && !closed) refreshVisual();
                    }
                  }),
                ),
              ),
            );
          };
          const clearLogo = () => {
            if (controlsLocked || cancelling) return;
            logoGeneration++;
            logoLoading = false;
            logoBytes = undefined;
            logoFile = undefined;
            if (logo !== null) logo.value = "";
            say("");
            refreshVisual();
            drawPreview();
          };
          const invalidateVisual = () => {
            visualGeneration++;
            visualAppearance = undefined;
            if (visualFiber !== undefined) run(Fiber.interrupt(visualFiber));
            visualFiber = undefined;
            for (const url of visualUrls) URL.revokeObjectURL(url);
            visualUrls.clear();
            for (const entry of entries) delete entry.visualImages;
            if (preview !== null) preview.dataset.visualReady = "false";
          };
          const refreshVisual = () => {
            invalidateVisual();
            const currentProfile = profile;
            const current = entries;
            const placements = current.flatMap((entry) =>
              entry.rect === undefined ? [] : [{ entry, rect: entry.rect }],
            );
            if (
              currentProfile === undefined ||
              placements.length !== current.length ||
              current.length === 0 ||
              logoLoading ||
              (logo?.files?.item(0) != null &&
                (logoBytes === undefined || logo.files.item(0) !== logoFile))
            )
              return;
            const generation = visualGeneration;
            const inputText =
              rubricSource?.value === "text"
                ? (rubricText?.value.trim() ?? "")
                : currentProfile.subject;
            if (inputText.length === 0) return;
            const stampTitle = title?.value.trim() || "ASSINADO DIGITALMENTE";
            const stampColor = color?.value ?? "#3B5BDB";
            const includeIdentity = identity?.getAttribute("aria-checked") === "true";
            const includeDate = date?.getAttribute("aria-checked") === "true";
            const useRubric = rubric?.getAttribute("aria-checked") === "true";
            const stampLogo = logoBytes;
            visualFiber = run(
              Effect.scoped(
                Effect.gen(function* () {
                  const handwriting = yield* PdfHandwriting;
                  const ink = yield* handwriting.render(inputText);
                  const badge: PdfSignatureBadge = {
                    header: { text: stampTitle },
                    rows: [
                      ...(includeIdentity
                        ? [
                            [{ label: "Assinante", value: currentProfile.subject }],
                            [
                              {
                                label: "Organização",
                                value: currentProfile.organization ?? currentProfile.subject,
                              },
                            ],
                            [
                              {
                                label: currentProfile.document.length === 14 ? "CNPJ" : "CPF",
                                value: currentProfile.document,
                              },
                            ],
                            [
                              {
                                label: "Certificado",
                                value: "ICP-Brasil (A1)",
                              },
                            ],
                          ]
                        : []),
                      ...(includeDate ? [[{ label: "Data", value: profileDate }]] : []),
                    ],
                    signaturePng: ink,
                    theme: { borderColor: stampColor, headerColor: stampColor },
                    ...(stampLogo === undefined ? {} : { logoPng: stampLogo }),
                    footer: [
                      { text: "MP 2.200-2/2001" },
                      { text: "Lei 14.063/2020" },
                      { text: "Portaria ITI nº 22/2023" },
                      { text: "validar.iti.gov.br", link: "https://validar.iti.gov.br" },
                      { text: "SignatureKit" },
                    ],
                    qr: { text: "https://validar.iti.gov.br" },
                  };
                  const appearance: Pick<PdfPrepareAndSignInput, "badge" | "rubric"> = {
                    badge,
                    ...(useRubric ? { rubric: { imagePng: ink, border: false } } : {}),
                  };
                  const worker = yield* makeSigningWorkerSession;
                  const staged = yield* Effect.acquireRelease(
                    Effect.sync(() => ({ urls: new Set<string>(), accepted: false })),
                    (state) =>
                      Effect.sync(() => {
                        if (!state.accepted) for (const url of state.urls) URL.revokeObjectURL(url);
                      }),
                  );
                  const rendered = yield* Effect.forEach(placements, ({ entry, rect }) =>
                    Effect.gen(function* () {
                      const bytes = yield* readPdfBlobBytes(entry.file);
                      const visualPdf = yield* worker.client.Preview({
                        pdf: bytes,
                        signing: {},
                        stampRects: [rect],
                        ...appearance,
                      });
                      const images = yield* renderPdfPagesBrowser(visualPdf, {
                        pageIndexes: entry.document.pages.map((_, pageIndex) => pageIndex),
                      });
                      const urls = yield* Effect.forEach(images, (page) =>
                        Effect.gen(function* () {
                          const url = yield* Effect.sync(() => {
                            const created = URL.createObjectURL(page.image);
                            staged.urls.add(created);
                            return created;
                          });
                          yield* decodePreviewImage(url);
                          return url;
                        }),
                      );
                      return { entry, images: urls };
                    }),
                  );
                  yield* Effect.sync(() => {
                    if (
                      closed ||
                      generation !== visualGeneration ||
                      entries !== current ||
                      profile !== currentProfile
                    )
                      return;
                    for (const item of rendered) item.entry.visualImages = item.images;
                    for (const url of staged.urls) visualUrls.add(url);
                    staged.accepted = true;
                    visualAppearance = appearance;
                    if (preview !== null) preview.dataset.visualReady = "true";
                    say("Prévia pronta.");
                    drawPreview();
                  });
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      pdfHandwritingBrowserLayer("600 64px 'Caveat Variable'"),
                      pdfCoreBrowserLayer,
                      pageRendererLayer(),
                    ),
                  ),
                ),
              ).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    if (generation === visualGeneration && !closed) say(message(error));
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (generation === visualGeneration) visualFiber = undefined;
                  }),
                ),
              ),
            );
          };
          const optionsChanged = () => {
            if (!controlsLocked && !cancelling) {
              refreshVisual();
              drawPreview();
            }
          };
          const readIdentity = () => {
            if (controlsLocked || cancelling) return;
            const file = pfx?.files?.item(0);
            const secret = password?.value ?? "";
            if (file == null || secret.length === 0) {
              say("Selecione o certificado e informe a senha.");
              return;
            }
            setLocked(true);
            profile = undefined;
            profileFile = undefined;
            if (identityStatus !== null) identityStatus.textContent = "";
            invalidateVisual();
            drawPreview();
            captureDocsEvent("pdf_signer_certificate_profile_started");
            say("Carregando identidade…");
            run(
              Effect.scoped(
                Effect.gen(function* () {
                  const worker = yield* makeSigningWorkerSession;
                  const pfxBytes = yield* Effect.tryPromise({
                    try: async () => new Uint8Array(await file.arrayBuffer()),
                    catch: () =>
                      new SignatureKitError({
                        code: SignatureKitErrorCodeValue.unsupportedOperation,
                        retryable: true,
                        reason: "Certificate file could not be read.",
                      }),
                  }).pipe(
                    Effect.tapError(() =>
                      Effect.sync(() =>
                        captureDocsEvent("pdf_signer_certificate_failed", { phase: "read_file" }),
                      ),
                    ),
                  );
                  captureDocsEvent("pdf_signer_certificate_loaded");
                  return yield* worker.client.Initialize({ pfx: pfxBytes, password: secret });
                }),
              ).pipe(
                Effect.tap((loaded) =>
                  Effect.sync(() => {
                    if (closed) return;
                    profile = loaded.profile;
                    profileFile = file;
                    profileDate = new Date().toLocaleString(locale);
                    if (identityStatus !== null)
                      identityStatus.textContent = loaded.profile.subject;
                    captureDocsEvent("pdf_signer_certificate_profile_loaded");
                    say("Identidade carregada.");
                    refreshVisual();
                    drawPreview();
                  }),
                ),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    captureDocsEvent("pdf_signer_certificate_profile_failed");
                    say(message(error));
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (!closed) setLocked(false);
                  }),
                ),
              ),
            );
          };
          const setLocked = (locked: boolean) => {
            controlsLocked = locked;
            form
              ?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
                "input, button, select",
              )
              .forEach((control) => {
                if (control !== cancel) control.disabled = locked;
              });
            for (const group of form?.querySelectorAll<HTMLFieldSetElement>("fieldset") ?? [])
              group.inert = locked && (cancel === null || !group.contains(cancel));
            if (preview !== null) preview.inert = locked;
            preview?.querySelector(".signing-page")?.setAttribute("aria-disabled", String(locked));
          };
          const submit = (event: Event) => {
            event.preventDefault();
            const certificate = pfx?.files?.item(0);
            const files = pdf?.files != null ? Array.from(pdf.files) : [];
            const secret = password?.value ?? "";
            if (
              certificate == null ||
              secret.length === 0 ||
              files.length === 0 ||
              files.length > 100
            ) {
              captureDocsEvent("pdf_signer_sign_blocked", {
                reason:
                  certificate == null
                    ? "missing_certificate"
                    : secret.length === 0
                      ? "missing_password"
                      : "no_signature_placement",
              });
              say("Selecione o certificado, a senha e de 1 a 100 PDFs.");
              return;
            }
            if (controlsLocked || cancelling) return;
            const ready =
              profile !== undefined &&
              profileFile === certificate &&
              visualAppearance !== undefined &&
              !logoLoading &&
              (logo?.files?.item(0) == null ||
                (logoBytes !== undefined && logo.files.item(0) === logoFile)) &&
              entries.length === files.length &&
              entries.every((entry, index) => {
                const rect = entry.rect;
                const page = rect === undefined ? undefined : entry.document.pages[rect.pageIndex];
                return (
                  entry.file === files[index] &&
                  rect !== undefined &&
                  page !== undefined &&
                  Number.isFinite(rect.x) &&
                  Number.isFinite(rect.y) &&
                  Number.isFinite(rect.width) &&
                  Number.isFinite(rect.height) &&
                  rect.x >= 0 &&
                  rect.y >= 0 &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.x + rect.width <= page.width &&
                  rect.y + rect.height <= page.height
                );
              });
            if (
              !ready &&
              element.getAttribute("data-signing-mode") === "rapida" &&
              entries.length === files.length &&
              entries.some((entry) => entry.rect === undefined)
            ) {
              placeAutomatically();
              say("Assinatura posicionada automaticamente. Confira e clique em Assinar.");
              return;
            }
            if (!ready) {
              captureDocsEvent("pdf_signer_sign_blocked", { reason: "no_signature_placement" });
              const hasPositions =
                entries.length === files.length &&
                entries.every((entry) => entry.rect !== undefined);
              say(
                profile === undefined || profileFile !== certificate
                  ? "Carregue a identidade do certificado."
                  : hasPositions && visualAppearance === undefined
                    ? "Aguarde a prévia da assinatura."
                    : "Aguarde os PDFs e posicione a assinatura em cada documento.",
              );
              return;
            }
            setLocked(true);
            captureDocsEvent("pdf_signer_sign_started", {
              document_count: files.length,
              rubric_every_page: rubric?.getAttribute("aria-checked") === "true",
            });
            if (password !== null) password.value = "";
            for (const url of urls) URL.revokeObjectURL(url);
            urls.clear();
            downloads?.replaceChildren();
            const placements = entries.flatMap((entry) =>
              entry.rect === undefined ? [] : [{ file: entry.file, rect: entry.rect }],
            );
            const appearance = visualAppearance;
            const expectedProfile = profile;
            if (appearance === undefined || expectedProfile === undefined) return;
            const current = ++batchId;
            say("Preparando assinatura…");
            active = run(
              Effect.scoped(
                Effect.gen(function* () {
                  const results = yield* batch.run({
                    target: "signing-view",
                    batchId: current,
                    documentIds: placements.map((_, index) => String(index)),
                    onState: (state) => {
                      const completed = state.documents.filter(
                        (item) => item.status === "completed" || item.status === "failed",
                      ).length;
                      if (status !== null) {
                        status.dataset.total = String(state.documents.length);
                        status.dataset.completed = String(completed);
                      }
                      if (progress !== null) {
                        progress.hidden = false;
                        progress.dataset.state =
                          completed === state.documents.length ? "complete" : "loading";
                        delete progress.dataset.indeterminate;
                        progress.setAttribute("aria-valuemin", "0");
                        progress.textContent = `${completed} / ${state.documents.length}`;
                        progress.setAttribute("aria-valuemax", String(state.documents.length));
                        progress.setAttribute("aria-valuenow", String(completed));
                      }
                      if (state.status === "running") {
                        say(
                          state.mode === "prepare"
                            ? "Preparando assinatura…"
                            : "Assinando documentos…",
                        );
                      }
                    },
                    prepare: Effect.gen(function* () {
                      const worker = yield* makeSigningWorkerSession;
                      session = worker;
                      const certificateBytes = yield* Effect.tryPromise({
                        try: async () => new Uint8Array(await certificate.arrayBuffer()),
                        catch: () =>
                          new SignatureKitError({
                            code: SignatureKitErrorCodeValue.unsupportedOperation,
                            retryable: true,
                            reason: "Certificate file could not be read.",
                          }),
                      }).pipe(
                        Effect.tapError(() =>
                          Effect.sync(() =>
                            captureDocsEvent("pdf_signer_certificate_failed", {
                              phase: "read_file",
                            }),
                          ),
                        ),
                      );
                      const initialized = yield* worker.client
                        .Initialize({
                          pfx: certificateBytes,
                          password: secret,
                        })
                        .pipe(
                          Effect.tapError(() =>
                            Effect.sync(() => {
                              captureDocsEvent("pdf_signer_identity_failed", {
                                phase: "sign_start",
                              });
                            }),
                          ),
                        );
                      if (initialized.profile.fingerprint !== expectedProfile.fingerprint) {
                        return yield* new SignatureKitError({
                          code: SignatureKitErrorCodeValue.unsupportedOperation,
                          retryable: false,
                          reason: "Certificate changed since preview.",
                        });
                      }
                      const documents = yield* Effect.forEach(placements, (entry, index) =>
                        readPdfBlobBytes(entry.file).pipe(
                          Effect.map((bytes) => ({
                            id: String(index),
                            input: {
                              pdf: bytes,
                              signing: {},
                              stampRects: [entry.rect],
                              ...appearance,
                            },
                          })),
                        ),
                      );
                      return {
                        generation: initialized.generation,
                        documents,
                        sign: worker.client.Sign,
                      };
                    }),
                  });
                  captureDocsEvent("pdf_signer_sign_completed", {
                    attempted_count: results.length,
                    failed_count: results.filter((item) => Result.isFailure(item.result)).length,
                    signed_count: results.filter((item) => Result.isSuccess(item.result)).length,
                  });
                  if (!closed && downloads !== null)
                    for (const result of results) {
                      if (Result.isSuccess(result.result)) {
                        const url = URL.createObjectURL(
                          new Blob([new Uint8Array(result.result.success)], {
                            type: "application/pdf",
                          }),
                        );
                        urls.add(url);
                        const link = document.createElement("a");
                        link.className = stylex.props(signing.download).className ?? "";
                        link.href = url;
                        link.download = `${"assinado"}-${files[Number(result.id)]?.name ?? "document.pdf"}`;
                        link.textContent = link.download;
                        link.addEventListener("click", () =>
                          captureDocsEvent("pdf_signer_signed_pdf_downloaded", {
                            document_count: 1,
                          }),
                        );
                        downloads.append(link, document.createElement("br"));
                      } else {
                        const failure = document.createElement("p");
                        failure.textContent = `${files[Number(result.id)]?.name ?? result.id}: ${message(result.result.failure)}`;
                        downloads.append(failure);
                      }
                    }
                  say(
                    results.some((item) => Result.isFailure(item.result))
                      ? "Alguns documentos não puderam ser assinados."
                      : "Assinatura concluída.",
                  );
                }).pipe(
                  Effect.ensuring(
                    Effect.gen(function* () {
                      if (session !== undefined) {
                        yield* session.close;
                        session = undefined;
                      }
                      active = undefined;
                      if (!cancelling) setLocked(false);
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      captureDocsEvent("pdf_signer_sign_failed", {
                        attempted_count: files.length,
                        phase: "sign_batch",
                        prepared_count: 0,
                      });
                      say(message(error));
                    }),
                  ),
                ),
              ),
            );
          };
          const stop = () => {
            if (!controlsLocked || cancelling || active === undefined) return;
            cancelling = true;
            say("Cancelando…");
            const current = active;
            run(
              Fiber.interrupt(current).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    cancelling = false;
                    setLocked(false);
                    say("Operação cancelada.");
                  }),
                ),
              ),
            );
          };
          loadIdentity?.addEventListener("click", readIdentity);
          for (const control of [title, color, identity, date, rubric, rubricSource, rubricText]) {
            control?.addEventListener("input", optionsChanged);
            control?.addEventListener("change", optionsChanged);
          }
          const invalidateToggle = () => {
            if (!controlsLocked && !cancelling) invalidateVisual();
          };
          const invalidateToggleKey = (event: KeyboardEvent) => {
            if (event.key === " ") invalidateToggle();
          };
          const toggles = element.querySelectorAll<HTMLElement>(".signing-toggle");
          for (const toggle of toggles) {
            toggle.addEventListener("click", invalidateToggle, true);
            toggle.addEventListener("keyup", invalidateToggleKey, true);
          }
          const toggleObserver = new MutationObserver(optionsChanged);
          for (const control of [identity, date, rubric]) {
            if (control !== null)
              toggleObserver.observe(control, {
                attributes: true,
                attributeFilter: ["aria-checked"],
              });
          }
          logo?.addEventListener("change", loadLogo);
          removeLogo?.addEventListener("click", clearLogo);
          pfx?.addEventListener("change", certificateSelected);
          pdf?.addEventListener("change", loadPreview);
          previous?.addEventListener("click", showPrevious);
          next?.addEventListener("click", showNext);
          auto?.addEventListener("click", placeAutomatically);
          form?.addEventListener("submit", submit);
          cancel?.addEventListener("click", stop);
          const cleanup = () => {
            if (closed) return;
            closed = true;
            toggleObserver.disconnect();
            for (const toggle of toggles) {
              toggle.removeEventListener("click", invalidateToggle, true);
              toggle.removeEventListener("keyup", invalidateToggleKey, true);
            }
            previewGeneration++;
            logoGeneration++;
            invalidateVisual();
            profile = undefined;
            profileFile = undefined;
            logoBytes = undefined;
            logoFile = undefined;
            if (password !== null) password.value = "";
            clearPreview();
            loadIdentity?.removeEventListener("click", readIdentity);
            for (const control of [
              title,
              color,
              identity,
              date,
              rubric,
              rubricSource,
              rubricText,
            ]) {
              control?.removeEventListener("input", optionsChanged);
              control?.removeEventListener("change", optionsChanged);
            }
            logo?.removeEventListener("change", loadLogo);
            removeLogo?.removeEventListener("click", clearLogo);
            pfx?.removeEventListener("change", certificateSelected);
            pdf?.removeEventListener("change", loadPreview);
            previous?.removeEventListener("click", showPrevious);
            next?.removeEventListener("click", showNext);
            auto?.removeEventListener("click", placeAutomatically);
            form?.removeEventListener("submit", submit);
            cancel?.removeEventListener("click", stop);
            unbridgePfx();
            unbridgePdf();
            unbridgeLogo();
            for (const fiber of fibers) Effect.runForkWith(runtimeContext)(Fiber.interrupt(fiber));
            for (const url of urls) URL.revokeObjectURL(url);
            urls.clear();
            cleanups.delete(cleanup);
          };
          cleanups.add(cleanup);
          return cleanup;
        }),
        (cleanup) => Effect.sync(cleanup),
      );
      return { _tag: "SigningMounted" };
    }),
});

const RubricSource = Schema.Literals(["certificate", "text"]);
const RubricRadios = RadioGroup.create<typeof RubricSource.Type>();
const rubricSources = ["certificate", "text"] satisfies ReadonlyArray<typeof RubricSource.Type>;
const FileTarget = Schema.Literals(["pfx", "pdf", "logo"]);

export const SigningMode = Schema.Literals(["rapida", "completa"]);
export const SigningFormModel = Schema.Struct({
  mode: SigningMode,
  appearance: Schema.Boolean,
  identity: Schema.Boolean,
  date: Schema.Boolean,
  rubric: Schema.Boolean,
  rubricSource: RubricSource,
  rubricGroup: RadioGroup.Model,
  pfx: FileDrop.Model,
  pdf: FileDrop.Model,
  logo: FileDrop.Model,
});
export type SigningFormModel = typeof SigningFormModel.Type;
export const Message = defineMessageUnion({
  SigningMounted: {},
  ModeSelected: { mode: SigningMode },
  AppearanceToggled: { open: Schema.Boolean },
  IdentityToggled: { checked: Schema.Boolean },
  DateToggled: { checked: Schema.Boolean },
  RubricToggled: { checked: Schema.Boolean },
  GotFileMessage: { targetId: FileTarget, message: FileDrop.Message },
  GotRubricSourceMessage: { message: RadioGroup.Message },
});
export type Message = typeof Message.Type;
export const signingFormInit = (): SigningFormModel => ({
  mode: "rapida",
  appearance: false,
  identity: true,
  date: true,
  rubric: false,
  rubricSource: "certificate",
  rubricGroup: RadioGroup.init({ id: "signing-rubric-source" }),
  pfx: FileDrop.init({ id: "signing-pfx" }),
  pdf: FileDrop.init({ id: "signing-pdf" }),
  logo: FileDrop.init({ id: "signing-logo" }),
});
const foldRubricSource = Update.foldChild({
  update: RubricRadios.update,
  read: (model: SigningFormModel) => Option.some(model.rubricGroup),
  write: (model, rubricGroup) => ({ ...model, rubricGroup }),
  toParentMessage: (message) => Message.GotRubricSourceMessage({ message }),
  foldOutMessage: RadioGroup.OutMessage.match({
    Selected:
      ({ value }) =>
      (model: SigningFormModel) => {
        const decoded = Schema.decodeUnknownOption(RubricSource)(value);
        return Option.match(decoded, {
          onNone: () => ({ model }),
          onSome: (rubricSource) => ({ model: { ...model, rubricSource } }),
        });
      },
  }),
});
export const signingFormUpdate = (model: SigningFormModel, message: Message) =>
  Message.match(message, {
    SigningMounted: () => ({ model }),
    ModeSelected: ({ mode }) => ({ model: { ...model, mode } }),
    AppearanceToggled: ({ open }) => ({ model: { ...model, appearance: open } }),
    IdentityToggled: ({ checked }) => ({ model: { ...model, identity: checked } }),
    DateToggled: ({ checked }) => ({ model: { ...model, date: checked } }),
    RubricToggled: ({ checked }) => ({ model: { ...model, rubric: checked } }),
    GotFileMessage: ({ targetId, message: dropped }) => {
      const next = FileDrop.update(
        targetId === "pfx" ? model.pfx : targetId === "pdf" ? model.pdf : model.logo,
        dropped,
      );
      return {
        model:
          targetId === "pfx"
            ? { ...model, pfx: next.model }
            : targetId === "pdf"
              ? { ...model, pdf: next.model }
              : { ...model, logo: next.model },
      };
    },
    GotRubricSourceMessage: ({ message: selected }) => ({
      model: foldRubricSource(model, selected).model,
    }),
  });

export const signingFormView = defineView<
  SigningFormModel,
  Message,
  { readonly embedded: boolean }
>((model, { embedded }, h) => {
  const input = (
    id: string,
    label: string,
    type: string,
    extra: ReadonlyArray<Attribute<Message>> = [],
  ) =>
    Input.view(
      {
        id: `signing-${id}`,
        name: id,
        type,
        toView: (attributes) =>
          h.label(
            [...sx(h, signing.label)],
            [
              label,
              h.input([
                ...attributes.input,
                ...extra,
                ...sx(h, type === "color" ? signing.color : signing.control),
              ]),
            ],
          ),
      },
      h,
    );
  const button = (
    label: string,
    attribute: string,
    type: "button" | "submit" = "button",
    tone: "primary" | "ghost" = "ghost",
  ) =>
    Button.view(
      {
        type,
        toView: (attributes) =>
          h.button(
            [
              ...attributes.button,
              h.Attribute(attribute, ""),
              ...sx(h, tone === "primary" ? shell.primary : shell.ghost),
            ],
            [label],
          ),
      },
      h,
    );
  const toggle = (
    id: string,
    data: string,
    label: string,
    checked: boolean,
    onToggle: (checked: boolean) => Message,
  ) =>
    h.div(
      [...sx(h, "signing-toggle", signing.switchRow)],
      [
        h.span([], [label]),
        Switch.view(
          {
            id,
            isChecked: checked,
            onToggle,
            toView: (attributes) =>
              h.button(
                [
                  ...attributes.button,
                  h.Attribute(data, ""),
                  ...sx(h, signing.switchButton, checked && signing.switchOn),
                ],
                [h.span([...sx(h, signing.knob, checked && signing.knobOn)])],
              ),
          },
          h,
        ),
      ],
    );
  const fileDrop = (
    drop: FileDrop.Model,
    name: "pfx" | "pdf" | "logo",
    label: string,
    hint: string,
    accept: ReadonlyArray<string>,
    multiple = false,
    glyph: IconName = "upload",
  ) =>
    h.submodel({
      slotId: drop.id,
      model: drop,
      view: FileDrop.view,
      viewInputs: {
        accept,
        multiple,
        toView: ({ root, input: fileInput }) =>
          h.label(
            [...root, ...sx(h, signing.drop, drop.isDragOver && signing.dropOver)],
            [
              h.span([...sx(h, signing.dropGlyph)], [icon(h, glyph)]),
              h.span(
                [...sx(h, signing.dropText)],
                [
                  h.strong([...sx(h, signing.dropTitle)], [label]),
                  h.span([...sx(h, signing.dropHint)], [hint]),
                ],
              ),
              h.span([...sx(h, signing.dropAction)], ["Escolher"]),
              h.input([
                ...fileInput.filter((child) => {
                  const attribute = child.attribute;
                  if (typeof attribute !== "object" || attribute === null || !("_tag" in attribute))
                    return true;
                  return attribute._tag !== "OnFileChange";
                }),
                h.Name(name === "logo" ? "stampLogo" : name),
                ...sx(h, signing.fileInput),
              ]),
            ],
          ),
      },
      toParentMessage: (message) => Message.GotFileMessage({ targetId: name, message }),
    });
  const field = (
    id: string,
    legend: string,
    area: "certificate" | "document" | "place" | "sign",
    children: ReadonlyArray<Html | null>,
  ) =>
    Fieldset.view(
      {
        id,
        toView: (attributes) =>
          h.fieldset(
            [
              ...attributes.fieldset,
              ...sx(
                h,
                area === "place" ? signing.card : signing.flat,
                area === "certificate"
                  ? signing.areaCertificate
                  : area === "document"
                    ? signing.areaDocument
                    : area === "place"
                      ? signing.areaPlace
                      : signing.areaSign,
              ),
            ],
            [
              h.legend(
                [
                  ...attributes.legend,
                  ...sx(h, area === "place" ? signing.legend : signing.srOnly),
                ],
                [legend],
              ),
              h.div([...sx(h, signing.fields)], children),
            ],
          ),
      },
      h,
    );
  return h.section(
    [
      ...sx(h, "docs-content", signing.page),
      h.Attribute("data-ph-no-capture", ""),
      h.Attribute("data-analytics-sensitive", ""),
      h.OnMount(Mount.mapMessage(SigningMount(), () => Message.SigningMounted())),
      h.Attribute("data-signing-mode", model.mode),
    ],
    [
      embedded ? null : h.h1([...sx(h, signing.title)], ["Assine documentos grátis"]),
      embedded
        ? null
        : h.p([...sx(h, signing.intro)], ["Assine PDFs no seu navegador com certificado A1."]),
      h.div(
        [...sx(h, signing.modes), h.Role("group"), h.AriaLabel("Modo de assinatura")],
        (["rapida", "completa"] satisfies ReadonlyArray<typeof SigningMode.Type>).map((mode) =>
          h.keyed("button")(
            mode,
            [
              ...sx(h, signing.mode, model.mode === mode && signing.modeOn),
              h.Type("button"),
              h.AriaPressed(model.mode === mode ? "true" : "false"),
              h.DataAttribute("signing-mode-option", mode),
              h.OnClick(Message.ModeSelected({ mode })),
            ],
            [
              icon(h, mode === "rapida" ? "zap" : "sliders"),
              mode === "rapida" ? "Rápida" : "Completa",
            ],
          ),
        ),
      ),
      h.p(
        [...sx(h, signing.privacy)],
        [icon(h, "lock"), "PDF, certificado e senha ficam no seu navegador. Nada é enviado."],
      ),
      h.form(
        [...sx(h, signing.form, model.mode === "rapida" && signing.formRapid)],
        [
          field("signing-certificate", "Certificado", "certificate", [
            fileDrop(
              model.pfx,
              "pfx",
              "Certificado A1",
              ".pfx ou .p12",
              [".pfx", ".p12"],
              false,
              "key",
            ),
            h.div(
              [...sx(h, signing.group)],
              [
                h.span([...sx(h, signing.groupGlyph)], [icon(h, "lock")]),
                Input.view(
                  {
                    id: "signing-password",
                    name: "password",
                    type: "password",
                    toView: (attributes) =>
                      h.input([
                        ...attributes.input,
                        h.AriaLabel("Senha do certificado"),
                        h.Attribute("placeholder", "Senha do certificado"),
                        h.Attribute("autocomplete", "off"),
                        ...sx(h, signing.groupInput),
                      ]),
                  },
                  h,
                ),
                Button.view(
                  {
                    toView: (attributes) =>
                      h.button(
                        [
                          ...attributes.button,
                          h.Attribute("data-load-identity", ""),
                          ...sx(h, signing.groupButton),
                        ],
                        ["Validar"],
                      ),
                  },
                  h,
                ),
              ],
            ),
            h.p([h.Attribute("data-identity", ""), ...sx(h, signing.hint)]),
          ]),
          field("signing-document", "Documentos", "document", [
            fileDrop(
              model.pdf,
              "pdf",
              "PDFs para assinar",
              "Solte ou escolha até 100 arquivos",
              ["application/pdf", ".pdf"],
              true,
            ),
          ]),
          h.div(model.mode === "rapida" ? [h.Hidden(true)] : [], [
            field("signing-place", "Posição e carimbo", "place", [
              h.div(
                [h.Attribute("data-preview", ""), ...sx(h, signing.stage)],
                [
                  h.p(
                    [...sx(h, signing.hint)],
                    ["Envie um PDF e clique na página para posicionar a assinatura."],
                  ),
                ],
              ),
              h.div(
                [...sx(h, signing.actions)],
                [
                  button("Página anterior", "data-previous"),
                  button("Próxima página", "data-next"),
                  button("Posicionar automaticamente", "data-auto"),
                ],
              ),
              Disclosure.view(
                {
                  id: "signing-appearance",
                  isOpen: model.appearance,
                  onToggle: (open) => Message.AppearanceToggled({ open }),
                  toView: ({ button: trigger, animatePanel }) =>
                    h.div(
                      [...sx(h, signing.appearance)],
                      [
                        h.button(
                          [...trigger, ...sx(h, signing.appearanceButton)],
                          [
                            "Aparência do carimbo",
                            h.span([h.AriaHidden(true)], [model.appearance ? "−" : "+"]),
                          ],
                        ),
                        animatePanel(
                          h.div(
                            [...sx(h, signing.fields, signing.appearancePanel)],
                            [
                              input("stampTitle", "Título da assinatura", "text"),
                              input("stampColor", "Cor", "color", [
                                h.Attribute("value", "#3B5BDB"),
                              ]),
                              fileDrop(model.logo, "logo", "Logo PNG", "Opcional", [
                                "image/png",
                                ".png",
                              ]),
                              button("Remover logo", "data-remove-logo"),
                              toggle(
                                "signing-stamp-identity",
                                "data-stamp-identity",
                                "Exibir identidade",
                                model.identity,
                                (checked) => Message.IdentityToggled({ checked }),
                              ),
                              toggle(
                                "signing-stamp-date",
                                "data-stamp-date",
                                "Exibir data",
                                model.date,
                                (checked) => Message.DateToggled({ checked }),
                              ),
                              toggle(
                                "signing-rubric",
                                "data-rubric",
                                "Rubricar demais páginas",
                                model.rubric,
                                (checked) => Message.RubricToggled({ checked }),
                              ),
                              h.submodel({
                                slotId: "signing-rubric-source",
                                model: model.rubricGroup,
                                view: RubricRadios.view,
                                viewInputs: {
                                  options: rubricSources,
                                  selectedValue: Option.some(model.rubricSource),
                                  ariaLabel: "Origem da rubrica",
                                  name: "rubricSource",
                                  toView: ({ group, options, hiddenInput }) =>
                                    h.div(
                                      [...group, ...sx(h, signing.radios)],
                                      [
                                        h.input(hiddenInput),
                                        ...options.map((option) =>
                                          h.button(
                                            [
                                              ...option.option,
                                              h.Attribute("data-rubric-source", option.value),
                                              ...sx(
                                                h,
                                                signing.radio,
                                                option.isSelected && signing.radioOn,
                                              ),
                                            ],
                                            [
                                              option.value === "text"
                                                ? "Texto digitado"
                                                : "Nome do certificado",
                                            ],
                                          ),
                                        ),
                                      ],
                                    ),
                                },
                                toParentMessage: (message) =>
                                  Message.GotRubricSourceMessage({ message }),
                              }),
                              input("rubricText", "Texto manuscrito", "text", [
                                h.Attribute("maxlength", "120"),
                              ]),
                            ],
                          ),
                        ),
                      ],
                    ),
                },
                h,
              ),
            ]),
          ]),
          field("signing-sign", "Assinar", "sign", [
            h.div(
              [...sx(h, signing.actions)],
              [
                Button.view(
                  {
                    type: "submit",
                    toView: (attributes) =>
                      h.button(
                        [
                          ...attributes.button,
                          h.Attribute("data-submit", ""),
                          ...sx(h, shell.primary, signing.submit),
                        ],
                        [icon(h, "pen"), "Assinar"],
                      ),
                  },
                  h,
                ),
                Button.view(
                  {
                    toView: (attributes) =>
                      h.button(
                        [
                          ...attributes.button,
                          h.Attribute("data-cancel", ""),
                          ...sx(h, signing.cancel),
                        ],
                        ["Cancelar"],
                      ),
                  },
                  h,
                ),
              ],
            ),
            Progress.view(
              {
                id: "signing-progress",
                ariaLabel: "Progresso da assinatura",
                toView: (attributes) =>
                  h.div([
                    ...attributes.progress,
                    h.Attribute("data-progress", ""),
                    h.Attribute("hidden", ""),
                  ]),
              },
              h,
            ),
            h.p([
              h.Attribute("data-status", ""),
              h.Attribute("role", "status"),
              ...sx(h, signing.hint),
            ]),
            h.div([h.Attribute("data-downloads", ""), ...sx(h, signing.downloads)]),
          ]),
        ],
      ),
    ],
  );
});
