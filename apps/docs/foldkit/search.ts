import { pageRoute } from "./routes";
import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { sx } from "./styles/sx";
import { tokens } from "./styles/tokens.stylex";
import { signatureKitErrorCatalog } from "@signature-kit/signatures";
import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import { contentPaths, expressionText, resolveContent } from "./content";
import type { ContentNode } from "./content-parse";

export const SearchQuery = Schema.String.check(Schema.isMaxLength(200));
export const SearchResult = Schema.Struct({
  title: Schema.String,
  heading: Schema.String,
  excerpt: Schema.String,
  href: Schema.String,
});
export const SearchResults = Schema.Array(SearchResult);
const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const excerptAround = (text: string, terms: ReadonlyArray<string>) => {
  const folded = normalize(text);
  const hit =
    folded.length === text.length
      ? terms.reduce((first, term) => {
          const index = folded.indexOf(term);
          return index >= 0 && (first < 0 || index < first) ? index : first;
        }, -1)
      : -1;
  if (hit < 48) return text.slice(0, 200);
  const start = text.lastIndexOf(" ", hit - 32) + 1;
  return `…${text.slice(start, start + 200)}`;
};

const markSegments = (text: string, query: string) => {
  const folded = normalize(text);
  const terms = normalize(query)
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (folded.length !== text.length || terms.length === 0) return [{ text, hit: false }];
  const segments: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    let next = -1;
    let length = 0;
    for (const term of terms) {
      const index = folded.indexOf(term, cursor);
      if (index >= 0 && (next < 0 || index < next)) {
        next = index;
        length = term.length;
      }
    }
    if (next < 0) break;
    if (next > cursor) segments.push({ text: text.slice(cursor, next), hit: false });
    segments.push({ text: text.slice(next, next + length), hit: true });
    cursor = next + length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
};

const styles = stylex.create({
  row: {
    display: "grid",
    gap: "2px",
    padding: "10px 12px",
    borderRadius: "10px",
    color: tokens.fg,
    textDecoration: "none",
    backgroundColor: { default: "transparent", ":hover": tokens.bgSubtle },
    ":focus-visible": {
      outline: "none",
      backgroundColor: tokens.bgSubtle,
      boxShadow: `inset 0 0 0 1px ${tokens.teal}`,
    },
  },
  section: {
    color: tokens.teal,
    fontFamily: tokens.mono,
    fontSize: "0.75rem",
    lineHeight: 1.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  title: {
    fontSize: "0.9375rem",
    fontWeight: 500,
    lineHeight: 1.4,
    letterSpacing: "-0.01em",
  },
  excerpt: {
    color: tokens.muted,
    fontSize: "0.875rem",
    lineHeight: 1.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  mark: {
    borderRadius: "3px",
    backgroundColor: tokens.accentSoft,
    color: tokens.fg,
  },
});

const marked = <Message>(h: HtmlBuilder<Message>, text: string, query: string) =>
  markSegments(text, query).map((segment) =>
    segment.hit ? h.mark([...sx(h, styles.mark)], [segment.text]) : segment.text,
  );

export const searchResultView = <Message>(
  h: HtmlBuilder<Message>,
  result: typeof SearchResult.Type,
  query: string,
) =>
  h.a(
    [...sx(h, styles.row), h.Href(result.href)],
    [
      h.span([...sx(h, styles.section)], [result.heading === "" ? "Página" : result.title]),
      h.span(
        [...sx(h, styles.title)],
        marked(h, result.heading === "" ? result.title : result.heading, query),
      ),
      ...(result.excerpt === ""
        ? []
        : [h.span([...sx(h, styles.excerpt)], marked(h, result.excerpt, query))]),
    ],
  );

type SearchPage = { slug: string; page: NonNullable<ReturnType<typeof resolveContent>> };
type SearchSection = {
  title: string;
  heading: string;
  href: string;
  text: string;
  foldedTitle: string;
  foldedHeading: string;
  foldedText: string;
};

const indexPages = (pages: ReadonlyArray<SearchPage>) => {
  const index: Array<SearchSection> = [];
  for (const { slug, page } of pages) {
    const base = pageRoute({
      path: `docs${slug === "index" ? "" : `/${slug.split("/").map(encodeURIComponent).join("/")}`}`,
    });
    const slugger = new GithubSlugger();
    const sections: { heading: string; href: string; text: string }[] = [
      { heading: "", href: base, text: page.description ?? "" },
    ];
    const visit = (nodes: ContentNode[]) => {
      for (const node of nodes) {
        if (node.type === "heading") {
          const children = [...(node.children ?? [])];
          const last = children.at(-1);
          const marker =
            last?.type === "text" ? last.value?.match(/\s*\[#([^\]\s]+)\]\s*$/) : undefined;
          if (marker !== null && marker !== undefined && last?.type === "text")
            children[children.length - 1] = { ...last, value: last.value?.slice(0, marker.index) };
          const heading = children
            .map(function visible(node): string {
              if (node.type === "mdxTextExpression") return expressionText(node);
              if ("children" in node) return node.children.map(visible).join("");
              return toString(node);
            })
            .join("");
          let id = marker?.[1];
          if (id !== undefined) {
            const original = id;
            let suffix = 0;
            while (Object.hasOwn(slugger.occurrences, id)) id = `${original}-${++suffix}`;
            slugger.occurrences[id] = 0;
          } else id = slugger.slug(toString({ type: "root", children }));
          sections.push({ heading, href: `${base}#${encodeURIComponent(id)}`, text: "" });
        } else if (
          (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
          (node.name === "Step" || node.name === "Card" || node.name === "Callout")
        ) {
          const attr = (name: string) => {
            const entry = node.attributes.find(
              (entry) => entry.type === "mdxJsxAttribute" && entry.name === name,
            );
            const value = entry?.type === "mdxJsxAttribute" ? entry.value : undefined;
            return typeof value === "string" ? value : "";
          };
          const section = sections.at(-1);
          if (node.name === "Step" && attr("title").length > 0 && section !== undefined)
            sections.push({ heading: attr("title"), href: section.href, text: "" });
          else if (section !== undefined)
            section.text += ` ${attr("title")} ${node.name === "Card" ? attr("description") : ""}`;
          visit(node.children);
        } else if (
          (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
          node.name === "ErrorCatalog"
        ) {
          for (const entry of signatureKitErrorCatalog)
            sections.push({
              heading: entry.code,
              href: `${base}#${encodeURIComponent(entry.code.replace("signature-kit.", "err-"))}`,
              text: `${entry.code} ${entry.message}${entry.overridable ? " editable" : ""}`,
            });
        } else if (node.type === "mdxTextExpression" || node.type === "mdxFlowExpression") {
          const section = sections.at(-1);
          if (section !== undefined) section.text += ` ${expressionText(node)}`;
        } else if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
          const section = sections.at(-1);
          if (section !== undefined) section.text += ` ${node.value ?? ""}`;
        } else if ("children" in node) visit(node.children);
      }
    };
    visit(page.nodes);
    for (const section of sections) {
      const text = section.text.trim().replace(/\s+/g, " ");
      index.push({
        title: page.title,
        heading: section.heading,
        href: section.href,
        text,
        foldedTitle: normalize(page.title),
        foldedHeading: normalize(section.heading),
        foldedText: normalize(section.text),
      });
    }
  }
  return index;
};

const indexCache = new Map<"docs", ReadonlyArray<SearchSection>>();
const defaultIndex = () => {
  const cached = indexCache.get("docs");
  if (cached !== undefined) return cached;
  const built = indexPages(
    contentPaths().flatMap((path) => {
      if (!path.startsWith("docs/")) return [];
      const slug = path.slice(5);
      const page = resolveContent("docs", slug);
      return page === undefined ? [] : [{ slug, page }];
    }),
  );
  indexCache.set("docs", built);
  return built;
};

export const searchDocs = (
  query: string,
  pages?: ReadonlyArray<SearchPage>,
): typeof SearchResults.Type => {
  const decoded = Schema.decodeUnknownOption(SearchQuery)(query);
  if (decoded._tag === "None") return [];
  const terms = normalize(decoded.value)
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  const results: {
    title: string;
    heading: string;
    excerpt: string;
    href: string;
    score: number;
  }[] = [];
  for (const section of pages === undefined ? defaultIndex() : indexPages(pages)) {
    if (
      !terms.every(
        (term) =>
          section.foldedTitle.includes(term) ||
          section.foldedHeading.includes(term) ||
          section.foldedText.includes(term),
      )
    )
      continue;
    const score = terms.reduce(
      (sum, term) =>
        sum +
        (section.foldedTitle.includes(term) ? 10 : 0) +
        (section.foldedHeading.includes(term) ? 5 : 0) +
        (section.foldedText.includes(term) ? 1 : 0),
      0,
    );
    results.push({
      title: section.title,
      heading: section.heading,
      excerpt: excerptAround(section.text, terms),
      href: section.href,
      score,
    });
  }
  const seen = new Set<string>();
  return results
    .sort((a, b) => b.score - a.score || a.href.localeCompare(b.href))
    .filter((result) => {
      const key = `${result.title}\n${result.heading}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20)
    .map(({ score: _score, ...result }) => result);
};
