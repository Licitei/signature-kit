import { Effect, Option, Schema } from "effect";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const manifest = await Effect.runPromise(
  Schema.decodeUnknownEffect(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      client: Schema.String,
      server: Schema.String,
      serverEntry: Schema.String,
      prerendered: Schema.Array(Schema.String),
    }),
  )(await Bun.file(resolve(root, "dist-foldkit/server/foldkit.build.json")).json()),
);
const client = resolve(root, manifest.client);
const server = resolve(root, manifest.server, manifest.serverEntry);
const handler = await import(pathToFileURL(server).href);
const prerendered = new Map(
  manifest.prerendered.map((path) => [
    path,
    resolve(client, ...path.split("/").filter(Boolean).map(decodeURIComponent), "index.html"),
  ]),
);

const encoded = new Map();
const compressible = /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/;

const optimizedPages = new Map();
const optimizePage = async (realFile) => {
  const cached = optimizedPages.get(realFile);
  if (cached !== undefined) return cached;
  const html = await Bun.file(realFile).text();
  const links = [
    ...html.matchAll(/<link rel="stylesheet"(?: crossorigin)? href="(\/assets\/[^"]+\.css)">/g),
  ];
  const styles = await Promise.all(
    links.map(([, href]) =>
      Bun.file(resolve(client, `.${href}`))
        .text()
        .catch(() => undefined),
    ),
  );
  const inlined = links
    .reduce(
      (page, [tag], index) =>
        styles[index] === undefined ? page : page.replace(tag, `<style>${styles[index]}</style>`),
      html,
    )
    .replace(/<link rel="modulepreload" crossorigin href="\/assets\/[^"]+\.js">/g, "")
    .replace(
      /<script type="module" crossorigin src="(\/assets\/[^"]+\.js)"><\/script>/,
      (_, src) =>
        `<script type="module">const intents = ["pointermove", "pointerdown", "touchstart", "keydown", "wheel", "scroll", "focusin"];const hydrate = () => { for (const name of intents) removeEventListener(name, hydrate, true); import(${JSON.stringify(src)}); };for (const name of intents) addEventListener(name, hydrate, { capture: true, passive: true });</script>`,
    )
    .replace(
      '<script type="module" src="/webmcp.js"></script>',
      '<script type="module">addEventListener("load", () => setTimeout(() => import("/webmcp.js")), { once: true });</script>',
    );
  const bytes = new TextEncoder().encode(inlined);
  optimizedPages.set(realFile, bytes);
  return bytes;
};

const fileResponse = async (request, realFile, type, cacheControl) => {
  const file =
    type.startsWith("text/html") === true
      ? new Blob([await optimizePage(realFile)])
      : Bun.file(realFile);
  const accept = request.headers.get("accept-encoding") ?? "";
  const encoding =
    compressible.test(type) === false || file.size < 1024
      ? undefined
      : accept.includes("br") === true
        ? "br"
        : accept.includes("gzip") === true
          ? "gzip"
          : undefined;
  if (encoding === undefined)
    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "content-type": type,
        "content-length": String(file.size),
        "cache-control": cacheControl,
        vary: "accept-encoding",
      },
    });
  const key = `${encoding}:${realFile}`;
  const body =
    encoded.get(key) ??
    (await file.bytes().then((bytes) => {
      const compressed =
        encoding === "br"
          ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
          : gzipSync(bytes, { level: 9 });
      encoded.set(key, compressed);
      return compressed;
    }));
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": type,
      "content-encoding": encoding,
      "content-length": String(body.byteLength),
      "cache-control": cacheControl,
      vary: "accept-encoding",
    },
  });
};

export const fetch = async (request) => {
  const path = new URL(request.url).pathname;
  const route = Schema.decodeUnknownOption(
    Schema.Struct({ _tag: Schema.Literal("Page"), path: Schema.String }),
  )(handler.parsePublicUrl(request.url));
  const agentPath =
    path === "/llms.txt" ||
    path === "/llms-full.txt" ||
    path === "/robots.txt" ||
    path === "/.well-known/search" ||
    path === "/api/search.json";
  if (agentPath === true) {
    const result = await handler.renderPage(request);
    return result._tag === "Responded" ? result.response : new Response(null, { status: 404 });
  }
  const wantsMarkdown =
    path.startsWith("/docs") === true &&
    String(request.headers.get("accept") ?? "").includes("text/markdown") === true;
  const socialImage =
    Option.isSome(route) &&
    route.value.path.endsWith(".webp") === true &&
    path.startsWith("/landing/") === false;
  if (socialImage || wantsMarkdown) {
    const result = await handler.renderPage(request);
    return result._tag === "Responded" ? result.response : new Response(null, { status: 404 });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const filePath = prerendered.get(path);
    if (typeof filePath === "string" && Boolean(filePath.startsWith(`${client}${sep}`))) {
      const realClient = await realpath(client).catch(() => null);
      const realFile = await realpath(filePath).catch(() => null);
      if (
        typeof realClient === "string" &&
        typeof realFile === "string" &&
        Boolean(realFile.startsWith(`${realClient}${sep}`)) &&
        Boolean((await stat(realFile).catch(() => null))?.isFile())
      ) {
        return fileResponse(
          request,
          realFile,
          "text/html; charset=utf-8",
          "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
        );
      }
    }

    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return new Response(null, { status: 400 });
    }
    const segments = decoded.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          segment.startsWith(".") ||
          segment.includes("\\") ||
          segment.includes("\0"),
      )
    ) {
      return new Response(null, { status: 404 });
    }
    const name = (segments.at(-1) ?? "").toLowerCase();
    if (
      segments.includes("server") ||
      name.endsWith(".html") ||
      name.endsWith(".map") ||
      /\.(?:ts|tsx|jsx|mjs|cjs)$/.test(name) ||
      name === "manifest.json" ||
      name === "foldkit.build.json"
    ) {
      return new Response(null, { status: 404 });
    }
    const staticPath = resolve(client, `.${decoded}`);
    const realClient = await realpath(client).catch(() => null);
    const realFile = await realpath(staticPath).catch(() => null);
    if (
      typeof realClient === "string" &&
      typeof realFile === "string" &&
      Boolean(realFile.startsWith(`${realClient}${sep}`)) &&
      Boolean((await stat(realFile).catch(() => null))?.isFile())
    ) {
      return fileResponse(
        request,
        realFile,
        Bun.file(realFile).type || "application/octet-stream",
        decoded.startsWith("/assets/") === true
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      );
    }
  }
  return handler.default.fetch(request);
};

if (import.meta.main === true) {
  const server = Bun.serve({ port: Number(process.env.PORT ?? 3001), fetch });
  console.log(`Listening on ${server.url}`);
}
