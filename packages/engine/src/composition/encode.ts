import { Effect } from "effect";
import { ComposeError } from "./config.js";
import type {
  ComposeDocument,
  ComposeFont,
  ComposeNode,
  ComposeOptions,
  Inline,
  PathCommand,
  Style,
  TextStyle,
} from "./config.js";

const spacing = { xs: 4, sm: 8, md: 12, lg: 18, xl: 26, xxl: 40 };
const sizes = { caption: 8, small: 9, body: 11, subtitle: 15, title: 24, display: 37 };
const palette = new Map(
  Object.entries({
    ink: 0x142127,
    muted: 0x54666a,
    paper: 0xf6f8f7,
    line: 0xd4dedb,
    accent: 0x126759,
    tint: 0xe8f2ee,
    white: 0xffffff,
  }),
);
const justify = ["start", "center", "end", "space-between", "space-around"];
const align = ["stretch", "start", "center", "end", "baseline"];
const textAlign = ["left", "center", "right", "justify"];
const controls = ["span", "hardBreak", "softBreak", "pageNumber", "totalPages"];
const noColor = 0xffffffff;
const utf8 = new TextEncoder();

class Wire {
  private buffer = new Uint8Array(4096);
  private view = new DataView(this.buffer.buffer);
  private offset = 0;

  private take(length: number): number {
    const start = this.offset;
    this.offset += length;
    if (this.offset > this.buffer.length) {
      const next = new Uint8Array(Math.max(this.offset, this.buffer.length * 2));
      next.set(this.buffer);
      this.buffer = next;
      this.view = new DataView(next.buffer);
    }
    return start;
  }

  byte(value: number): void {
    const offset = this.take(1);
    this.view.setUint8(offset, value);
  }

  word(value: number): void {
    const offset = this.take(4);
    this.view.setUint32(offset, value, true);
  }

  number(value: number): void {
    const offset = this.take(8);
    this.view.setFloat64(offset, value, true);
  }

  bytes(value: Uint8Array): void {
    const start = this.take(value.length);
    this.buffer.set(value, start);
  }

  blob(value: Uint8Array): void {
    this.word(value.length);
    this.bytes(value);
  }

  text(value: string): void {
    this.blob(utf8.encode(value));
  }

  finish(): Uint8Array {
    return this.buffer.subarray(0, this.offset);
  }
}

type Space = NonNullable<Style["gap"]>;
const space = (value: Space): number => (typeof value === "number" ? value : spacing[value]);
const color = (value: NonNullable<Style["color"]>): number =>
  value.startsWith("#") ? Number.parseInt(value.slice(1), 16) : (palette.get(value) ?? noColor);
const dimension = (value: Style["width"]): number =>
  typeof value === "string" ? -Number.parseFloat(value) : (value ?? 0);
const fontSize = (value: NonNullable<TextStyle["fontSize"]>): number =>
  typeof value === "number" ? value : sizes[value];

function edges(wire: Wire, value: NonNullable<Style["padding"]>): void {
  const values = typeof value === "object" ? value : [value, value, value, value];
  for (const edge of values) wire.number(space(edge));
}

function style(wire: Wire, value: Style): void {
  const flags =
    (value.direction === "row" ? 0 : 1) |
    (value.wrap === true ? 2 : 0) |
    (value.keepTogether === true ? 4 : 0) |
    (value.widowsOrphans === true ? 8 : 0);
  wire.byte(flags);
  wire.byte(justify.indexOf(value.justify ?? "start"));
  wire.byte(align.indexOf(value.align ?? "stretch"));
  wire.byte(textAlign.indexOf(value.textAlign ?? "left"));
  wire.word(value.background === undefined ? noColor : color(value.background));
  const border = value.borderColor ?? (value.borderWidth === undefined ? undefined : "line");
  wire.word(border === undefined ? noColor : color(border));
  for (const measure of [
    value.width,
    value.height,
    value.minWidth,
    value.maxWidth,
    value.minHeight,
    value.maxHeight,
  ]) {
    wire.number(dimension(measure));
  }
  edges(wire, value.margin ?? 0);
  edges(wire, value.padding ?? 0);
  wire.number(space(value.gap ?? 0));
  wire.number(value.borderRadius ?? 0);
  wire.number(value.borderWidth ?? (value.borderColor === undefined ? 0 : 1));
  wire.number(value.opacity ?? 1);
  wire.number(value.grow ?? 0);
  wire.number(value.shrink ?? 1);
  wire.number(dimension(value.basis));
  wire.number(value.lineHeight ?? 1.24);
}

function pathCommand(wire: Wire, command: PathCommand): void {
  switch (command.kind) {
    case "move":
    case "line":
      wire.byte(command.kind === "move" ? 0 : 1);
      for (const position of command.point) wire.number(position);
      break;
    case "curve":
      wire.byte(2);
      for (const point of command.via) for (const position of point) wire.number(position);
      break;
    case "close":
      wire.byte(3);
      break;
  }
}

function faceKey(font: Pick<ComposeFont, "family" | "style" | "weight">): string {
  return `${font.family}/${font.style}/${font.weight}`;
}

class Encoder {
  readonly wire = new Wire();
  readonly fonts: Uint8Array[] = [];
  readonly images: Uint8Array[] = [];
  private readonly fontIndexes = new Map<string, number>();
  private readonly imageIndexes = new Map<Uint8Array, number>();
  private readonly catalog: ReadonlyMap<string, ComposeFont>;

  constructor(fonts: readonly ComposeFont[]) {
    this.catalog = new Map(fonts.map((font) => [faceKey(font), font]));
  }

  face(font: Pick<ComposeFont, "family" | "style" | "weight">): number | undefined {
    const key = faceKey(font);
    const previous = this.fontIndexes.get(key);
    if (previous !== undefined) return previous;
    const asset = this.catalog.get(key);
    if (asset === undefined) return undefined;
    const index = this.fonts.length;
    this.fonts.push(asset.bytes);
    this.fontIndexes.set(key, index);
    return index;
  }

  private *run(value: Inline, parent: TextStyle) {
    const { wire } = this;
    const appearance = typeof value === "string" ? parent : { ...parent, ...value.style };
    const family = appearance.family ?? "Plex Sans";
    const style = appearance.fontStyle ?? "normal";
    const weight = appearance.fontWeight ?? 400;
    const kind = typeof value === "string" ? 0 : controls.indexOf(value.kind);
    const face = kind === 1 || kind === 2 ? 0 : this.face({ family, style, weight });
    if (face === undefined) {
      return yield* new ComposeError({
        code: "invalidFont",
        reason: `Missing font face ${family} ${weight} ${style}`,
      });
    }
    wire.byte(kind);
    wire.word(face);
    wire.number(fontSize(appearance.fontSize ?? "body"));
    wire.number(appearance.letterSpacing ?? 0);
    wire.word(color(appearance.color ?? "ink"));
    wire.text(typeof value === "string" ? value : value.kind === "span" ? value.text : "");
  }

  private image(bytes: Uint8Array): number {
    const prior = this.imageIndexes.get(bytes);
    if (prior !== undefined) return prior;
    const index = this.images.length;
    this.images.push(bytes);
    this.imageIndexes.set(bytes, index);
    return index;
  }

  private *children(nodes: readonly ComposeNode[], parent: TextStyle, depth: number) {
    this.wire.word(nodes.length);
    for (const node of nodes) yield* this.node(node, parent, depth);
  }

  *node(node: ComposeNode, parent: TextStyle, depth: number): Effect.fn.Return<void, ComposeError> {
    if (depth > 48)
      return yield* new ComposeError({
        code: "invalidDocument",
        reason: "Compose tree is too deep",
      });
    const { wire } = this;
    const appearance = { ...parent, ...node.style };
    switch (node.kind) {
      case "view":
        wire.byte(0);
        style(wire, node.style);
        yield* this.children(node.children, appearance, depth + 1);
        return;
      case "text":
        wire.byte(1);
        style(wire, node.style);
        wire.word(node.runs.length);
        for (const run of node.runs) yield* this.run(run, appearance);
        return;
      case "image":
        wire.byte(2);
        style(wire, node.style);
        wire.word(this.image(node.bytes));
        wire.byte(node.fit === "cover" ? 1 : 0);
        return;
      case "shape":
        wire.byte(3);
        style(wire, node.style);
        wire.word(node.path.length);
        for (const command of node.path) pathCommand(wire, command);
        return;
      case "anchor":
        wire.byte(4);
        style(wire, node.style);
        wire.text(node.name);
        wire.byte(node.field ? 1 : 0);
        return;
      case "pageBreak":
        wire.byte(5);
        style(wire, node.style);
        return;
      case "table":
        wire.byte(6);
        style(wire, node.style);
        wire.word(node.header.length);
        yield* this.children([...node.header, ...node.rows], appearance, depth + 1);
        return;
      case "link":
        wire.byte(7);
        style(wire, node.style);
        wire.text(node.uri);
        yield* this.children(node.children, appearance, depth + 1);
        return;
    }
  }
}

export const encodeComposition = Effect.fn(function* (
  document: ComposeDocument,
  defaults: readonly ComposeFont[],
  options: ComposeOptions,
) {
  const encoder = new Encoder([...defaults, ...(options.fonts ?? [])]);
  if (encoder.face({ family: "Plex Sans", weight: 400, style: "normal" }) === undefined) {
    return yield* new ComposeError({
      code: "invalidFont",
      reason: "The default font face is unavailable",
    });
  }
  const { wire } = encoder;
  const { metadata = {} } = options;
  wire.text(metadata.title ?? "");
  wire.text(metadata.author ?? "");
  wire.text(metadata.createdAt ?? "");
  wire.word(document.pages.length);
  for (const page of document.pages) {
    const dimensions =
      page.size === "A4" ? [595.2756, 841.8898] : page.size === "Letter" ? [612, 792] : page.size;
    for (const measure of dimensions) wire.number(measure);
    edges(wire, page.margins);
    yield* encoder.node(page.header, {}, 0);
    yield* encoder.node(page.footer, {}, 0);
    yield* encoder.node(page.body, {}, 0);
  }
  if (encoder.images.length > 256) {
    return yield* new ComposeError({ code: "invalidDocument", reason: "Too many image assets" });
  }
  const result = new Wire();
  result.bytes(utf8.encode("SKC2"));
  const assets = [...encoder.fonts, ...encoder.images];
  result.word(encoder.fonts.length);
  result.word(encoder.images.length);
  for (let index = 0; index < assets.length; index++) result.word(0);
  result.bytes(wire.finish());
  return { request: result.finish(), assets };
});
