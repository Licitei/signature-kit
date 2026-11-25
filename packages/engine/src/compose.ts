import { Context, Effect, Schema, SchemaIssue } from "effect";
import { ComposeError, ComposeOptionsSchema, DocumentSchema } from "./composition/config.js";
import type {
  ComposeDocument,
  ComposeFont,
  ComposeNode,
  ComposeOptions,
  ComposePage,
  Inline,
  PathCommand,
  Style,
  TextStyle,
} from "./composition/config.js";
import { encodeComposition } from "./composition/encode.js";

export {
  ComposeError,
  ComposeOptionsSchema,
  DocumentSchema,
  StyleSchema,
} from "./composition/config.js";
export type {
  ComposeDocument,
  ComposeFont,
  ComposeNode,
  ComposeOptions,
  ComposePage,
  Inline,
  PathCommand,
  Style,
  TextStyle,
} from "./composition/config.js";

export const Document = (...pages: readonly ComposePage[]): ComposeDocument => ({ pages });

export const Page = (
  children: readonly ComposeNode[],
  options: Partial<Omit<ComposePage, "body">> = {},
): ComposePage => ({
  size: options.size ?? "A4",
  margins: options.margins ?? 52,
  header: options.header ?? Stack([]),
  footer: options.footer ?? Stack([]),
  body: Stack(children),
});

export const Box = (children: readonly ComposeNode[], style: Style = {}): ComposeNode => ({
  kind: "view",
  style,
  children,
});

export const Stack = (children: readonly ComposeNode[], style: Style = {}): ComposeNode =>
  Box(children, { ...style, direction: "column" });

export const Row = (children: readonly ComposeNode[], style: Style = {}): ComposeNode =>
  Box(children, { ...style, direction: "row" });

export const Span = (text: string, style: TextStyle = {}): Inline => ({
  kind: "span",
  text,
  style,
});
export const SoftBreak = (): Inline => ({ kind: "softBreak" });
export const HardBreak = (): Inline => ({ kind: "hardBreak" });
export const PageNumber = (style: TextStyle = {}): Inline => ({ kind: "pageNumber", style });
export const TotalPages = (style: TextStyle = {}): Inline => ({ kind: "totalPages", style });

export const Text = (content: Inline | readonly Inline[], style: Style = {}): ComposeNode => ({
  kind: "text",
  style,
  runs: typeof content === "string" || "kind" in content ? [content] : content,
});

export const Heading = (content: Inline | readonly Inline[], style: Style = {}): ComposeNode =>
  Text(content, { fontSize: "title", fontWeight: 700, keepTogether: true, ...style });

export const Paragraph = (content: Inline | readonly Inline[], style: Style = {}): ComposeNode =>
  Text(content, { fontSize: "body", lineHeight: 1.45, widowsOrphans: true, ...style });

export const Table = (
  header: readonly ComposeNode[],
  rows: readonly ComposeNode[],
  style: Style = {},
): ComposeNode => ({ kind: "table", style, header, rows });

export const Image = (
  bytes: Uint8Array,
  style: Style = {},
  fit: "contain" | "cover" = "contain",
): ComposeNode => ({ kind: "image", bytes, fit, style });

export const Path = (path: readonly PathCommand[], style: Style): ComposeNode => ({
  kind: "shape",
  style,
  path,
});

export const Rect = (style: Style): ComposeNode => Path([], style);
export const Rule = (style: Style = {}): ComposeNode =>
  Rect({ background: "line", height: 1, ...style });

export const Badge = (label: string, style: Style = {}): ComposeNode =>
  Text(label, {
    color: "accent",
    fontSize: "caption",
    fontWeight: 700,
    background: "tint",
    borderRadius: 4,
    padding: [3, 7, 3, 7],
    keepTogether: true,
    ...style,
  });

export const Link = (
  uri: string,
  children: readonly ComposeNode[],
  style: Style = {},
): ComposeNode => ({ kind: "link", uri, children, style });

export const Anchor = (name: string, style: Style = {}): ComposeNode => ({
  kind: "anchor",
  name,
  field: false,
  style,
});

export const SignatureField = (name: string, style: Style = {}): ComposeNode => ({
  kind: "anchor",
  name,
  field: true,
  style: { height: 48, ...style },
});

export const Rubric = (name: string, style: Style = {}): ComposeNode =>
  Anchor(name, { height: 22, ...style });

export const PageBreak = (): ComposeNode => ({ kind: "pageBreak", style: {} });

export const KeepTogether = (children: readonly ComposeNode[], style: Style = {}): ComposeNode =>
  Stack(children, { ...style, keepTogether: true });

export class ComposeRuntime extends Context.Service<
  ComposeRuntime,
  {
    readonly fonts: Effect.Effect<readonly ComposeFont[], ComposeError>;
    readonly render: (
      input: Effect.Success<ReturnType<typeof encodeComposition>>,
    ) => Effect.Effect<Uint8Array, ComposeError>;
  }
>()("@signature-kit/engine/ComposeRuntime") {}

const formatIssue = SchemaIssue.makeFormatterDefault();

export const compose = Effect.fn(function* (
  document: ComposeDocument,
  options: ComposeOptions = {},
) {
  const tree = yield* Schema.decodeUnknownEffect(DocumentSchema, { onExcessProperty: "error" })(
    document,
  ).pipe(
    Effect.mapError(
      ({ issue }) => new ComposeError({ code: "invalidDocument", reason: formatIssue(issue) }),
    ),
  );
  const settings = yield* Schema.decodeUnknownEffect(ComposeOptionsSchema, {
    onExcessProperty: "error",
  })(options).pipe(
    Effect.mapError(
      ({ issue }) => new ComposeError({ code: "invalidDocument", reason: formatIssue(issue) }),
    ),
  );
  const runtime = yield* ComposeRuntime;
  const fonts = yield* runtime.fonts;
  const input = yield* encodeComposition(tree, fonts, settings);
  return yield* runtime.render(input);
});
