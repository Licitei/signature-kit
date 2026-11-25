import { pageRoute } from "./routes";
import { Effect, Schema } from "effect";
import { contentPaths, resolveContent } from "./content";

export type ArticleSection = "blog" | "changelog";

export const ArticleDate = Schema.Struct({
  date: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/),
    Schema.makeFilter((value) => {
      const year = Number(value.slice(0, 4));
      const month = Number(value.slice(5, 7));
      const day = Number(value.slice(8, 10));
      const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
      return (
        Number.isFinite(calendar.getTime()) &&
        calendar.getUTCFullYear() === year &&
        calendar.getUTCMonth() + 1 === month &&
        calendar.getUTCDate() === day
      );
    }),
  ).pipe(Schema.decodeTo(Schema.DateFromString)),
});

export const articleCrops = [
  "center bottom",
  "left center",
  "right top",
  "center top",
  "right center",
] satisfies ReadonlyArray<string>;
export const articleCrop = (slug: string) =>
  Array.from(slug).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) %
  articleCrops.length;

export const tagSlug = (tag: string) => tag.toLowerCase().replace(/\s+/g, "-");
export const indexTags = (
  entries: ReturnType<typeof indexArticles>,
  source: (slug: string) => ReturnType<typeof resolveContent>,
) => {
  const grouped = new Map<
    string,
    { slug: string; tag: string; entries: ReturnType<typeof indexArticles> }
  >();
  for (const entry of entries) {
    const content = source(entry.slug);
    if (content === undefined) continue;
    for (const tag of content.tags ?? []) {
      const slug = tagSlug(tag);
      const group = grouped.get(slug) ?? { slug, tag, entries: [] };
      group.entries.push(entry);
      grouped.set(slug, group);
    }
  }
  return [...grouped.values()];
};

export const indexArticles = (
  section: ArticleSection,
  entries: Iterable<{
    slug: string;
    content: NonNullable<ReturnType<typeof resolveContent>> & { date: string; timestamp: number };
  }>,
) =>
  Array.from(entries, ({ slug, content }) => ({
    ...content,
    slug,
    href: pageRoute({ path: `${section}/${encodeURIComponent(slug)}` }),
  })).sort((a, b) => b.timestamp - a.timestamp || a.slug.localeCompare(b.slug));

export const createArticleCatalog = (source: {
  paths: typeof contentPaths;
  resolve: typeof resolveContent;
}) => {
  const resolveArticle = (section: ArticleSection, slug: string) => {
    const content = source.resolve(section, slug);
    if (content === undefined) return undefined;
    // [allow-run: article dates are validated at the static content boundary]
    const { date } = Effect.runSync(Schema.decodeUnknownEffect(ArticleDate)(content));
    return { ...content, date: date.toISOString(), timestamp: date.getTime() };
  };

  const articles = (section: ArticleSection) => {
    const slugs = new Set(
      source
        .paths()
        .filter((path) => path.startsWith(`${section}/`))
        .map((path) => path.slice(section.length + 1)),
    );
    return indexArticles(
      section,
      [...slugs].flatMap((slug) => {
        const content = resolveArticle(section, slug);
        return content !== undefined ? [{ slug, content }] : [];
      }),
    );
  };

  const articlePaths = () =>
    (["blog", "changelog"] satisfies ArticleSection[]).flatMap((section) => [
      pageRoute({ path: section }),
      ...articles(section).map((article) => article.href),
    ]);

  const blogTags = () => indexTags(articles("blog"), (slug) => source.resolve("blog", slug));
  const tagPaths = () => [
    pageRoute({ path: "blog/tags" }),
    ...blogTags().map(({ slug }) => pageRoute({ path: `blog/tags/${encodeURIComponent(slug)}` })),
  ];

  return { resolveArticle, articles, articlePaths, blogTags, tagPaths };
};

export const { resolveArticle, articles, articlePaths, blogTags, tagPaths } = createArticleCatalog({
  paths: contentPaths,
  resolve: resolveContent,
});
