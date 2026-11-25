import { Effect, Schema } from "effect";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseDocument } from "yaml";

export const ReleaseCover = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("spans"),
    caption: Schema.String,
    package: Schema.optional(Schema.String),
    spans: Schema.Array(
      Schema.Struct({ name: Schema.String, start: Schema.Finite, width: Schema.Finite }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("pages"),
    caption: Schema.String,
    package: Schema.optional(Schema.String),
    total: Schema.Finite,
    selected: Schema.Array(Schema.Finite),
    code: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("metric"),
    caption: Schema.String,
    package: Schema.optional(Schema.String),
    before: Schema.String,
    after: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("anchor"),
    caption: Schema.String,
    package: Schema.optional(Schema.String),
    code: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("states"),
    caption: Schema.String,
    package: Schema.optional(Schema.String),
    states: Schema.Array(Schema.String),
    code: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("bytes"),
    caption: Schema.String,
    package: Schema.optional(Schema.String),
    bytes: Schema.String,
    highlight: Schema.Tuple([Schema.Finite, Schema.Finite]),
    code: Schema.String,
  }),
]);
export type ReleaseCover = typeof ReleaseCover.Type;
const Frontmatter = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  cover: Schema.optional(ReleaseCover),
  packages: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
});
const ParsedFrontmatter = Schema.Struct({ valid: Schema.Literal(true), value: Frontmatter });
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);
export type NativeNode = ReturnType<typeof parser.parse>["children"][number];
export type ContentNode = NativeNode;

export const parseContent = (source: string) => {
  const lines = source.split("\n");
  const start = lines[0]?.trim() === "---";
  const end = start ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") : -1;
  const document = parseDocument(end < 0 ? "" : lines.slice(1, end).join("\n"));
  // [allow-run: static content is validated at the application boundary]
  const { value } = Effect.runSync(
    Schema.decodeUnknownEffect(ParsedFrontmatter)({
      valid: start && end >= 0 && document.errors.length === 0,
      value: document.errors.length === 0 ? document.toJS() : undefined,
    }).pipe(Effect.orDie),
  );
  const tree = parser.parse(lines.slice(end + 1).join("\n"));
  return { ...value, nodes: tree.children };
};
export type ParsedContent = ReturnType<typeof parseContent>;
