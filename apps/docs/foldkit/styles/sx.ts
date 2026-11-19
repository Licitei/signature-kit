import * as stylex from "@stylexjs/stylex";
import type {
  CompiledStyles,
  InlineStyles,
  StyleXArray,
  Theme,
  VarGroup,
} from "@stylexjs/stylex/lib/types/StyleXTypes";
import type { Attribute, HtmlBuilder } from "foldkit/html";

type StyleArg = StyleXArray<
  | null
  | undefined
  | boolean
  | CompiledStyles
  | Theme<VarGroup<{}>>
  | Readonly<[CompiledStyles, InlineStyles]>
>;

const isStyleValue = (value: string | number | undefined): value is string | number =>
  value !== undefined;

const readStyles = (...styles: ReadonlyArray<StyleArg>): ReturnType<typeof stylex.props> =>
  stylex.props(...styles);

export const sx = <Message>(
  h: HtmlBuilder<Message>,
  ...styles: ReadonlyArray<StyleArg | string>
): ReadonlyArray<Attribute<Message>> => {
  const names: Array<string> = [];
  const compiled: Array<StyleArg> = [];
  for (const style of styles) {
    if (typeof style === "string") names.push(style);
    else compiled.push(style);
  }
  const result = readStyles(...compiled);
  const attributes: Array<Attribute<Message>> = [];
  if (result.className !== undefined && result.className.length > 0) names.push(result.className);
  if (names.length > 0) attributes.push(h.Class(names.join(" ")));
  if (result.style !== undefined) {
    const style: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.style)) {
      if (isStyleValue(value)) style[key] = String(value);
    }
    if (Object.keys(style).length > 0) attributes.push(h.Style(style));
  }
  return attributes;
};
