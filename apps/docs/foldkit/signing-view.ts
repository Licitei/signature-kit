import {
  Button,
  Disclosure,
  Fieldset,
  FileDrop,
  Input,
  Progress,
  RadioGroup,
  Switch,
  Tabs,
} from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Update } from "foldkit";
import type { Attribute, Html } from "foldkit/html";
import { defineView } from "foldkit/submodel";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import { shell } from "./styles/shell";
import { signing } from "./styles/signing";
import { sx } from "./styles/sx";
import { icon } from "./icons";
import type { IconName } from "./icons";

export const SigningMounted = Schema.TaggedStruct("SigningMounted", {});
const SigningMount = Mount.define("SigningMount", {
  messages: [SigningMounted],
  execute: ({ element }) =>
    Effect.promise(() => import("./signing-mount")).pipe(
      Effect.flatMap(({ mountSigning }) => mountSigning(element)),
      Effect.as(SigningMounted.make({})),
    ),
});

const ModeTabs = Tabs.create<typeof SigningMode.Type>();
const RubricSource = Schema.Literals(["certificate", "text"]);
const RubricRadios = RadioGroup.create<typeof RubricSource.Type>();
const rubricSources = ["certificate", "text"] satisfies ReadonlyArray<typeof RubricSource.Type>;
const FileTarget = Schema.Literals(["pfx", "pdf", "logo"]);

export const SigningMode = Schema.Literals(["rapida", "completa"]);
export const SigningFormModel = Schema.Struct({
  mode: SigningMode,
  modeTabs: Tabs.Model,
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
  GotModeTabsMessage: { message: Tabs.Message },
  FormSubmitted: {},
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
  modeTabs: Tabs.init({ id: "signing-mode" }),
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
const foldModeTabs = Update.foldChild({
  update: ModeTabs.update,
  read: (model: SigningFormModel) => Option.some(model.modeTabs),
  write: (model, modeTabs) => ({ ...model, modeTabs }),
  toParentMessage: (message) => Message.GotModeTabsMessage({ message }),
  foldOutMessage: Tabs.OutMessage.match({
    Selected:
      ({ value }) =>
      (model: SigningFormModel) =>
        Option.match(Schema.decodeUnknownOption(SigningMode)(value), {
          onNone: () => ({ model }),
          onSome: (mode) => ({ model: { ...model, mode } }),
        }),
  }),
});
export const signingFormUpdate = (model: SigningFormModel, message: Message) =>
  Message.match(message, {
    SigningMounted: () => ({ model }),
    GotModeTabsMessage: ({ message: tab }) => ({ model: foldModeTabs(model, tab).model }),
    FormSubmitted: () => ({ model }),
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

export const signingFormView = defineView<SigningFormModel, Message>((model, h) => {
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
              ...sx(h, tone === "primary" ? shell.primary : signing.smallButton),
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
      h.submodel({
        slotId: "signing-mode",
        model: model.modeTabs,
        view: ModeTabs.view,
        viewInputs: {
          tabs: ["rapida", "completa"],
          selectedValue: model.mode,
          ariaLabel: "Modo de assinatura",
          panelMount: "ActiveOnly",
          toView: ({ tablist, tabs }) =>
            h.div(
              [...tablist, ...sx(h, signing.modes)],
              tabs.map((tab) =>
                h.button(
                  [
                    ...tab.tab,
                    h.DataAttribute("signing-mode-option", tab.value),
                    ...sx(h, signing.mode, tab.isActive && signing.modeOn),
                  ],
                  [
                    icon(h, tab.value === "rapida" ? "zap" : "sliders"),
                    tab.value === "rapida" ? "Rápida" : "Completa",
                  ],
                ),
              ),
            ),
        },
        toParentMessage: (message) => Message.GotModeTabsMessage({ message }),
      }),
      h.p(
        [...sx(h, signing.privacy)],
        [icon(h, "lock"), "PDF, certificado e senha ficam no seu navegador. Nada é enviado."],
      ),
      h.div(
        [
          h.Id(`signing-mode-panel-${model.mode === "rapida" ? "0" : "1"}`),
          h.Role("tabpanel"),
          h.AriaLabelledBy(`signing-mode-tab-${model.mode === "rapida" ? "0" : "1"}`),
        ],
        [
          h.form(
            [
              ...sx(h, signing.form, model.mode === "rapida" && signing.formRapid),
              h.OnSubmit(Message.FormSubmitted()),
            ],
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
              h.div(
                [
                  ...sx(h, signing.areaPlace, model.mode !== "rapida" && signing.placeWrap),
                  ...(model.mode === "rapida" ? [h.Hidden(true)] : []),
                ],
                [
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
                                  h.span(
                                    [
                                      ...sx(
                                        h,
                                        signing.chevron,
                                        model.appearance && signing.chevronOpen,
                                      ),
                                    ],
                                    [icon(h, "chevron")],
                                  ),
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
                ],
              ),
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
                              h.Hidden(true),
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
      ),
    ],
  );
});
