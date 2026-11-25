import { toolPages } from "./tool-pages";
import { Effect } from "effect";
import { pageRoute } from "./routes";
import { contentPaths, contentSource, docsNavigation, resolveContent } from "./content";
import { searchDocs } from "./search";
import { siteOrigin } from "./site-origin";

const attribute = (source: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`).exec(source)?.[1] ?? "";

const absolute = (href: string) => (href.startsWith("/") ? `${siteOrigin}${href}` : href);

export const mdxToMarkdown = (source: string) => {
  const lines = source.split("\n");
  const end =
    lines[0]?.trim() === "---" ? lines.findIndex((line, i) => i > 0 && line.trim() === "---") : -1;
  return lines
    .slice(end + 1)
    .join("\n")
    .replace(/<\/?Cards>\n?/g, "")
    .replace(/<\/?Steps>\n?/g, "")
    .replace(/<Card\b([^>]*?)\/>/g, (_, attrs: string) => {
      const description = attribute(attrs, "description");
      return `- [${attribute(attrs, "title")}](${absolute(attribute(attrs, "href"))})${description !== undefined && description !== "" ? `: ${description}` : ""}`;
    })
    .replace(
      /<Card\b([^>]*)>([\s\S]*?)<\/Card>/g,
      (_, attrs: string, body: string) =>
        `- [${attribute(attrs, "title")}](${absolute(attribute(attrs, "href"))}): ${body.trim().replace(/\s+/g, " ")}`,
    )
    .replace(/<Step\b([^>]*)>/g, (_, attrs: string) => `### ${attribute(attrs, "title")}\n`)
    .replace(/<\/Step>/g, "")
    .replace(/<Callout\b([^>]*)>([\s\S]*?)<\/Callout>/g, (_, attrs: string, body: string) => {
      const title = attribute(attrs, "title");
      const text = body
        .trim()
        .split("\n")
        .map((line) => `> ${line.trim()}`)
        .join("\n");
      return `${title !== "" ? `> **${title}**\n>\n` : ""}${text}`;
    })
    .replace(/<ErrorCatalog\s*\/>/g, `Catálogo completo: ${siteOrigin}/docs/signing/errors`)
    .replace(/```package-install\n([^\n]*)\n```/g, "```bash\nbun add $1\n```")
    .replace(/\]\(\//g, `](${siteOrigin}/`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const dedent = (markdown: string) => {
  let fence: number | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      if (line.trimStart().startsWith("```")) {
        if (fence === undefined) fence = indent;
        else fence = undefined;
        return line.trimStart();
      }
      if (fence !== undefined) return line.slice(Math.min(fence, indent));
      return /^\s*([-*]|\d+\.)\s/.test(line)
        ? line.slice(Math.min(indent, indent - (indent % 2)))
        : line.trimStart();
    })
    .join("\n");
};

export const pageMarkdown = (slug: string) => {
  const source = contentSource("docs", slug);
  const page = resolveContent("docs", slug);
  if (source === undefined || page === undefined) return undefined;
  const url = `${siteOrigin}${pageRoute({ path: slug === "" || slug === "index" ? "docs" : `docs/${slug}` })}`;
  return [
    `# ${page.title}`,
    ...(page.description !== undefined ? [`> ${page.description}`] : []),
    `Fonte: ${url}`,
    dedent(mdxToMarkdown(source)),
  ].join("\n\n");
};

export const agentInstructions =
  "Documentação do SignatureKit em pt-BR. Para buscar, chame o endpoint com q=<termos>; a resposta vem em Markdown com o conteúdo das páginas. Cada página também existe em Markdown com .md ou Accept: text/markdown. Índice completo em /llms.txt.";
export const agentMeta = {
  instructions: agentInstructions,
  endpoint: `${siteOrigin}/.well-known/search?q={query}`,
  method: "GET",
  documentation: `${siteOrigin}/llms.txt`,
};

const agentFrontMatter = () =>
  [
    "---",
    "agent:",
    `  instructions: ${JSON.stringify(agentMeta.instructions)}`,
    `  endpoint: ${JSON.stringify(agentMeta.endpoint)}`,
    `  method: ${agentMeta.method}`,
    `  documentation: ${JSON.stringify(agentMeta.documentation)}`,
    "---",
  ].join("\n");

export const searchMarkdown = (query: string) => {
  const results = searchDocs(query);
  const seen = new Set<string>();
  const pages = results.flatMap((result) => {
    const route = result.href.split("#")[0] ?? "";
    if (seen.has(route) || seen.size >= 5) return [];
    seen.add(route);
    const slug = route === "/docs" ? "index" : route.slice(6);
    const markdown = pageMarkdown(slug);
    const score = Math.max(0.05, 1 - (seen.size - 1) * 0.15).toFixed(2);
    return markdown === undefined ? [] : [`## ${route}.md (score: ${score})\n\n${markdown}`];
  });
  return [
    `# Search results for: "${query}"`,
    pages.length === 0
      ? "Nenhum resultado. Veja o índice em /llms.txt."
      : pages.join("\n\n---\n\n"),
  ].join("\n\n");
};

const docSlugs = () =>
  contentPaths()
    .filter((path) => path.startsWith("docs/"))
    .map((path) => path.slice(5));

export const llmsTxt = () =>
  [
    "# SignatureKit",
    "> Assinatura digital com certificado A1 em TypeScript (PDF/PAdES, XML-DSig) e integração com Clicksign, Assinafy, ZapSign, DocuSeal e Documenso. Biblioteca open source baseada em Effect, mantida pela Licitei.",
    "Cada página da documentação existe em Markdown: acrescente `.md` à URL ou envie `Accept: text/markdown`. A documentação inteira está em /llms-full.txt e a busca em /api/search.json?q=.",
    ...docsNavigation().map((group) =>
      [
        `## ${group.title}`,
        ...group.links.map((link) => {
          const slug = link.href === "/docs" ? "index" : link.href.slice(6);
          const description = resolveContent("docs", slug)?.description;
          return `- [${link.title}](${siteOrigin}${link.href}.md)${description !== undefined && description !== "" ? `: ${description}` : ""}`;
        }),
      ].join("\n"),
    ),
    [
      "## Ferramentas no navegador",
      ...toolPages.map(
        (page) => `- [${page.nav.label}](${siteOrigin}/${page.path}): ${page.description}`,
      ),
      `- [pdf-core](${siteOrigin}/pdf-core): motor de PDF em Rust e WebAssembly, com benchmarks e demonstração no navegador`,
    ].join("\n"),
    [
      "## Outros",
      `- [Blog](${siteOrigin}/blog)`,
      `- [Changelog](${siteOrigin}/changelog)`,
      `- [Código-fonte](https://github.com/Licitei/signature-kit)`,
    ].join("\n"),
  ].join("\n\n");

export const llmsFullTxt = () =>
  docSlugs()
    .flatMap((slug) => {
      const markdown = pageMarkdown(slug);
      return markdown === undefined ? [] : [markdown];
    })
    .join("\n\n---\n\n");

export const robotsTxt = () =>
  [
    "User-agent: *",
    "Allow: /",
    "Disallow: /search",
    "",
    ...[
      "GPTBot",
      "OAI-SearchBot",
      "ChatGPT-User",
      "ClaudeBot",
      "Claude-User",
      "Claude-SearchBot",
      "PerplexityBot",
      "Google-Extended",
      "Applebot-Extended",
      "CCBot",
    ].flatMap((agent) => [`User-agent: ${agent}`, "Allow: /", ""]),
    `Sitemap: ${siteOrigin}/sitemap.xml`,
    `# Documentação para agentes: ${siteOrigin}/llms.txt`,
  ].join("\n");

const text = (body: string, type: string, method: string) =>
  new Response(method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": `${type}; charset=utf-8`,
      "Access-Control-Allow-Origin": "*",
      Vary: "Accept",
    },
  });

const queryFromBody = (body: string, type: string) => {
  if (!type.includes("application/json")) return body.trim();
  const parsed = /"q"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
  return parsed === undefined ? "" : parsed.replace(/\\(.)/g, "$1");
};

export const agentResponse = (request: Request): Effect.Effect<Response | undefined> =>
  Effect.gen(function* () {
    if (new URL(request.url).pathname === "/.well-known/search" && request.method === "QUERY") {
      const body = yield* Effect.promise(() => request.text());
      return text(
        searchMarkdown(
          queryFromBody(body, request.headers.get("content-type") ?? "").slice(0, 200),
        ),
        "text/markdown",
        "GET",
      );
    }
    return yield* agentGet(request);
  });

const agentGet = (request: Request): Effect.Effect<Response | undefined> =>
  Effect.sync(() => {
    const url = new URL(request.url);
    const path = url.pathname;
    const wantsMarkdown = (request.headers.get("accept") ?? "").includes("text/markdown");
    const agentPath =
      path === "/llms.txt" ||
      path === "/llms-full.txt" ||
      path === "/robots.txt" ||
      path === "/api/search.json" ||
      path === "/.well-known/search" ||
      (path.startsWith("/docs") && (path.endsWith(".md") || wantsMarkdown));
    if (!agentPath) return undefined;
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, {
        status: 405,
        headers: { Allow: path === "/.well-known/search" ? "GET, HEAD, QUERY" : "GET, HEAD" },
      });
    if (path === "/.well-known/search")
      return text(
        searchMarkdown((url.searchParams.get("q") ?? "").slice(0, 200)),
        "text/markdown",
        request.method,
      );
    if (path === "/robots.txt") return text(robotsTxt(), "text/plain", request.method);
    if (path === "/llms.txt") return text(llmsTxt(), "text/plain", request.method);
    if (path === "/llms-full.txt") return text(llmsFullTxt(), "text/plain", request.method);
    if (path === "/api/search.json")
      return text(
        JSON.stringify(
          searchDocs(url.searchParams.get("q") ?? "").map((result) => ({
            ...result,
            href: `${siteOrigin}${result.href}`,
            markdown: `${siteOrigin}${result.href.split("#")[0]}.md`,
          })),
        ),
        "application/json",
        request.method,
      );
    const route = path.endsWith(".md") ? path.slice(0, -3) : path;
    const slug = route === "/docs" || route === "/docs/index" ? "index" : route.slice(6);
    const markdown = pageMarkdown(slug);
    return markdown === undefined
      ? new Response("Página não encontrada", { status: 404 })
      : text(`${agentFrontMatter()}\n\n${markdown}`, "text/markdown", request.method);
  });
