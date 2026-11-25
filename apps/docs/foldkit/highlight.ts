import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { icon } from "./icons";
import { prose } from "./styles/prose";
import { sx } from "./styles/sx";
import { tokens } from "./styles/tokens.stylex";

const styles = stylex.create({
  keyword: { color: tokens.teal },
  string: { color: tokens.accent },
  comment: { color: tokens.faint, fontStyle: "italic" },
  number: { color: tokens.ink },
});

type TokenKind = keyof typeof styles;
export type CodeToken = { readonly kind: TokenKind | "plain"; readonly text: string };

const scriptKeywords = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "readonly",
  "return",
  "satisfies",
  "switch",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "while",
  "yield",
]);
const shellKeywords = new Set(["bun", "bunx", "npm", "npx", "pnpm", "yarn", "cd", "export"]);
const dataKeywords = new Set(["true", "false", "null"]);

const families: Record<string, { pattern: RegExp; keywords: ReadonlySet<string> }> = {
  script: {
    pattern:
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g,
    keywords: scriptKeywords,
  },
  shell: {
    pattern:
      /((?:^|(?<=\s))#[^\n]*)|("(?:\\.|[^"\\\n])*"|'[^'\n]*')|(\b\d[\d.]*\b)|([A-Za-z_][\w-]*)/gm,
    keywords: shellKeywords,
  },
  data: {
    pattern: /(\/\/[^\n]*)|("(?:\\.|[^"\\\n])*")|(-?\b\d[\d.eE+-]*\b)|([A-Za-z_]\w*)/g,
    keywords: dataKeywords,
  },
};

const languageFamily: Record<string, string> = {
  ts: "script",
  tsx: "script",
  js: "script",
  jsx: "script",
  mjs: "script",
  typescript: "script",
  javascript: "script",
  bash: "shell",
  sh: "shell",
  shell: "shell",
  json: "data",
  jsonc: "data",
};

export const tokenizeCode = (source: string, language: string): ReadonlyArray<CodeToken> => {
  const family = families[languageFamily[language] ?? ""];
  if (family === undefined) return [{ kind: "plain", text: source }];
  const output: Array<CodeToken> = [];
  let plain = "";
  let cursor = 0;
  const push = (kind: TokenKind, text: string) => {
    if (plain.length > 0) output.push({ kind: "plain", text: plain });
    plain = "";
    output.push({ kind, text });
  };
  for (const match of source.matchAll(family.pattern)) {
    plain += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const [text, comment, string, number, word] = match;
    if (comment !== undefined) push("comment", text);
    else if (string !== undefined) push("string", text);
    else if (number !== undefined) push("number", text);
    else if (word !== undefined && family.keywords.has(word)) push("keyword", text);
    else plain += text;
  }
  plain += source.slice(cursor);
  if (plain.length > 0) output.push({ kind: "plain", text: plain });
  return output;
};

export const highlightCode = <Message>(
  h: HtmlBuilder<Message>,
  source: string,
  language: string,
): ReadonlyArray<Html | string> =>
  tokenizeCode(source, language).map((token) =>
    token.kind === "plain" ? token.text : h.span([...sx(h, styles[token.kind])], [token.text]),
  );

export const codeBlock = <Message>(
  h: HtmlBuilder<Message>,
  input: { label: string; source: string; language: string },
) =>
  h.div(
    [...sx(h, prose.codeBlock)],
    [
      h.div(
        [...sx(h, prose.codeHead)],
        [
          h.span([], [input.label]),
          h.button(
            [
              ...sx(h, prose.codeCopy),
              h.Type("button"),
              h.Attribute("data-copy-code", ""),
              h.AriaLabel("Copiar código"),
            ],
            [
              h.span([...sx(h, prose.codeCopyIcon)], [icon(h, "copy")]),
              h.span([...sx(h, prose.codeCopyIcon, prose.codeCopyDone)], [icon(h, "check")]),
            ],
          ),
        ],
      ),
      h.pre(
        [...sx(h, prose.pre), h.Attribute("tabindex", "0")],
        [
          h.code(
            [...sx(h, `language-${input.language}`, prose.blockCode)],
            highlightCode(h, input.source, input.language),
          ),
        ],
      ),
    ],
  );
