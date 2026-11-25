import { Schema } from "effect";

const Measure = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 14400 }));
const Positive = Measure.check(Schema.isGreaterThan(0));
const Factor = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Ratio = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Fraction = Schema.String.check(
  Schema.isPattern(/^(?:100|[1-9]\d?(?:\.\d+)?|0\.\d*[1-9]\d*)%$/),
);
export const Spacing = Schema.Literals(["xs", "sm", "md", "lg", "xl", "xxl"]);
export const TypeScale = Schema.Literals([
  "caption",
  "small",
  "body",
  "subtitle",
  "title",
  "display",
]);
export const Palette = Schema.Literals([
  "ink",
  "muted",
  "paper",
  "line",
  "accent",
  "tint",
  "white",
]);
const Color = Schema.Union([Palette, Schema.String.check(Schema.isPattern(/^#[a-fA-F0-9]{6}$/))]);
const Printable = Schema.String.check(
  Schema.makeFilter((value: string) => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) return "Control characters are not allowed";
    }
    return true;
  }),
);
const Dimension = Schema.Union([Positive, Fraction]);
const Space = Schema.Union([Measure, Spacing]);
export const Edges = Schema.Union([Space, Schema.Tuple([Space, Space, Space, Space])]);
const FontStyle = Schema.Literals(["normal", "italic"]);
const Weight = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 900 }));

export const TextStyleSchema = Schema.Struct({
  color: Schema.optional(Color),
  family: Schema.optional(Schema.NonEmptyString),
  fontSize: Schema.optional(Schema.Union([Positive, TypeScale])),
  fontStyle: Schema.optional(FontStyle),
  fontWeight: Schema.optional(Weight),
  letterSpacing: Schema.optional(
    Schema.Finite.check(Schema.isBetween({ minimum: -3, maximum: 20 })),
  ),
});
export type TextStyle = typeof TextStyleSchema.Type;

export const StyleSchema = Schema.Struct({
  ...TextStyleSchema.fields,
  align: Schema.optional(Schema.Literals(["stretch", "start", "center", "end"])),
  background: Schema.optional(Color),
  basis: Schema.optional(Dimension),
  borderColor: Schema.optional(Color),
  borderRadius: Schema.optional(Measure),
  borderWidth: Schema.optional(Measure),
  direction: Schema.optional(Schema.Literals(["column", "row"])),
  gap: Schema.optional(Space),
  grow: Schema.optional(Factor),
  height: Schema.optional(Dimension),
  justify: Schema.optional(
    Schema.Literals(["start", "center", "end", "space-between", "space-around"]),
  ),
  keepTogether: Schema.optional(Schema.Boolean),
  lineHeight: Schema.optional(Positive.check(Schema.isLessThanOrEqualTo(10))),
  margin: Schema.optional(Edges),
  maxHeight: Schema.optional(Dimension),
  maxWidth: Schema.optional(Dimension),
  minHeight: Schema.optional(Dimension),
  minWidth: Schema.optional(Dimension),
  opacity: Schema.optional(Ratio),
  padding: Schema.optional(Edges),
  shrink: Schema.optional(Factor),
  textAlign: Schema.optional(Schema.Literals(["left", "center", "right", "justify"])),
  widowsOrphans: Schema.optional(Schema.Boolean),
  width: Schema.optional(Dimension),
  wrap: Schema.optional(Schema.Boolean),
});
export type Style = typeof StyleSchema.Type;

const Span = Schema.Struct({
  kind: Schema.Literal("span"),
  text: Schema.String,
  style: TextStyleSchema,
});
const Control = Schema.Struct({
  kind: Schema.Literals(["hardBreak", "softBreak", "pageNumber", "totalPages"]),
  style: Schema.optional(TextStyleSchema),
});
export const Inline = Schema.Union([Schema.String, Span, Control]);
export type Inline = typeof Inline.Type;

const Point = Schema.Tuple([Measure, Measure]);
const Move = Schema.Struct({ kind: Schema.Literals(["move", "line"]), point: Point });
const Curve = Schema.Struct({
  kind: Schema.Literal("curve"),
  via: Schema.Tuple([Point, Point, Point]),
});
const Close = Schema.Struct({ kind: Schema.Literal("close") });
export const PathCommand = Schema.Union([Move, Curve, Close]);
export type PathCommand = typeof PathCommand.Type;

const StyleField = { style: StyleSchema };
const ViewFields = { ...StyleField, kind: Schema.Literal("view") };
const TableFields = { ...StyleField, kind: Schema.Literal("table") };
const LinkFields = {
  ...StyleField,
  kind: Schema.Literal("link"),
  uri: Printable.check(Schema.isPattern(/^(https?:\/\/|mailto:).+$/)),
};
const Leaf = Schema.Union([
  Schema.Struct({ ...StyleField, kind: Schema.Literal("text"), runs: Schema.Array(Inline) }),
  Schema.Struct({
    ...StyleField,
    kind: Schema.Literal("image"),
    bytes: Schema.Uint8Array,
    fit: Schema.Literals(["contain", "cover"]),
  }),
  Schema.Struct({ ...StyleField, kind: Schema.Literal("shape"), path: Schema.Array(PathCommand) }),
  Schema.Struct({
    ...StyleField,
    kind: Schema.Literal("anchor"),
    field: Schema.Boolean,
    name: Printable.check(Schema.isPattern(/^[^.]{1,160}$/)),
  }),
  Schema.Struct({ ...StyleField, kind: Schema.Literal("pageBreak") }),
]);

export type ComposeNode =
  | typeof Leaf.Type
  | (Schema.Struct.Type<typeof ViewFields> & { readonly children: readonly ComposeNode[] })
  | (Schema.Struct.Type<typeof TableFields> & {
      readonly header: readonly ComposeNode[];
      readonly rows: readonly ComposeNode[];
    })
  | (Schema.Struct.Type<typeof LinkFields> & { readonly children: readonly ComposeNode[] });

export const NodeSchema = Schema.Union([
  Leaf,
  Schema.Struct({
    ...ViewFields,
    children: Schema.Array(Schema.suspend((): Schema.Codec<ComposeNode> => NodeSchema)),
  }),
  Schema.Struct({
    ...TableFields,
    header: Schema.Array(Schema.suspend((): Schema.Codec<ComposeNode> => NodeSchema)),
    rows: Schema.Array(Schema.suspend((): Schema.Codec<ComposeNode> => NodeSchema)),
  }),
  Schema.Struct({
    ...LinkFields,
    children: Schema.Array(Schema.suspend((): Schema.Codec<ComposeNode> => NodeSchema)),
  }),
]);

export const PageSchema = Schema.Struct({
  size: Schema.Union([Schema.Literals(["A4", "Letter"]), Schema.Tuple([Positive, Positive])]),
  margins: Edges,
  header: NodeSchema,
  body: NodeSchema,
  footer: NodeSchema,
});
export type ComposePage = typeof PageSchema.Type;

export const DocumentSchema = Schema.Struct({
  pages: Schema.Array(PageSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ComposeDocument = typeof DocumentSchema.Type;

export const ComposeMetadata = Schema.Struct({
  title: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String.check(Schema.isPattern(/^D:\d{14}Z$/))),
});
export const ComposeFont = Schema.Struct({
  family: Schema.NonEmptyString,
  weight: Weight,
  style: FontStyle,
  bytes: Schema.Uint8Array,
});
export type ComposeFont = typeof ComposeFont.Type;
export const ComposeOptionsSchema = Schema.Struct({
  fonts: Schema.optional(Schema.Array(ComposeFont).check(Schema.isMaxLength(60))),
  metadata: Schema.optional(ComposeMetadata),
});
export type ComposeOptions = typeof ComposeOptionsSchema.Type;

export class ComposeError extends Schema.TaggedError<
  ComposeError,
  { readonly brand: unique symbol }
>()("ComposeError", {
  code: Schema.Literals([
    "invalidDocument",
    "invalidFont",
    "assetLoadFailed",
    "wasmFailed",
    "composeFailed",
  ]),
  reason: Schema.String,
  status: Schema.optional(Schema.Int),
}) {
  get message(): string {
    return this.reason;
  }
}
