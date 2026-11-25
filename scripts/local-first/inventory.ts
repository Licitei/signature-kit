import { createHash } from "node:crypto";
import { existsSync, globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname } from "node:path";
import { Schema } from "effect";
import { build } from "vite";

const root = new URL("../../", import.meta.url);
const file = (path: string) => new URL(path, root);
const byPath = (left: string, right: string) => left.localeCompare(right, "en");
const files = (pattern: string) =>
  globSync(pattern, { cwd: root, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath}/${entry.name}`.slice(root.pathname.length))
    .sort(byPath);
const read = async <S extends Schema.Top & { readonly DecodingServices: never }>(
  path: string,
  schema: S,
) => Schema.decodeUnknownPromise(Schema.fromJsonString(schema))(await readFile(file(path), "utf8"));

const dependencyMap = Schema.Record(Schema.String, Schema.String);
const Manifest = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean),
  exports: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Struct({ import: Schema.String })]),
    ),
  ),
  dependencies: Schema.optional(dependencyMap),
  peerDependencies: Schema.optional(dependencyMap),
});
const RegistryItem = Schema.Struct({
  files: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  ),
});

const size = (bytes: Uint8Array) => ({
  raw: bytes.byteLength,
  gzip: gzipSync(bytes, { level: 9 }).byteLength,
});
const sizes = async (path: string) => size(await readFile(file(path)));
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(file(path)))
    .digest("hex");
const code = (value: string) => `\`${value}\``;
const table = (headers: string[], rows: ReadonlyArray<ReadonlyArray<string | number>>) => {
  const row = (cells: ReadonlyArray<string | number>) =>
    `| ${cells.map((cell) => String(cell).replaceAll("|", "\\|")).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n");
};
const dependencies = (entries: Record<string, string> | undefined) =>
  Object.entries(entries ?? {})
    .map(([name, version]) => code(`${name}@${version}`))
    .join(", ") || "—";

const { workspaces } = await read(
  "package.json",
  Schema.Struct({ workspaces: Schema.Array(Schema.String) }),
);
const manifests = workspaces.flatMap((glob) => files(`${glob}/package.json`)).sort(byPath);
const packageRows: Array<ReadonlyArray<string | number>> = [];
const exportRows: Array<ReadonlyArray<string>> = [];
const workerFiles: string[] = [];
const wasmFiles: string[] = [];
for (const path of manifests) {
  const manifest = await read(path, Manifest);
  if (manifest.private === true || manifest.exports === undefined) continue;
  const directory = dirname(path);
  const dist = files(`${directory}/dist/**/*`);
  if (dist.length === 0) process.exitCode = 1;
  let raw = 0;
  let gzip = 0;
  for (const artifact of dist) {
    const measured = await sizes(artifact);
    raw += measured.raw;
    gzip += measured.gzip;
    if (artifact.endsWith(".wasm")) wasmFiles.push(artifact);
    if (artifact.endsWith(".worker.js")) workerFiles.push(artifact);
  }
  packageRows.push([
    code(manifest.name),
    dist.length,
    raw,
    gzip,
    dependencies(manifest.dependencies),
    dependencies(manifest.peerDependencies),
  ]);
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const entry = typeof target === "string" ? target : target.import;
    const source = entry.endsWith(".wasm")
      ? "shared/pdf-core/scripts/build-wasm.sh"
      : `${directory}/${entry.replace(/^\.\/dist\//u, "src/").replace(/\.js$/u, ".ts")}`;
    if (!existsSync(file(source)) || !existsSync(file(`${directory}/${entry.slice(2)}`))) {
      process.exitCode = 1;
    }
    const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    exportRows.push([code(specifier), code(`${directory}/${entry.slice(2)}`), code(source)]);
  }
}

const docsOutputs = files("apps/docs/{public,dist-foldkit}/**/*");
wasmFiles.push(
  ...files("shared/pdf-core/rust/target/wasm32-unknown-unknown/release/**/*.wasm"),
  ...docsOutputs.filter((path) => path.endsWith(".wasm")),
);
workerFiles.push(...docsOutputs.filter((path) => /worker[^/]*\.m?js$/u.test(path)));
const wasmRows = await Promise.all(
  wasmFiles.sort(byPath).map(async (path) => {
    const { raw, gzip } = await sizes(path);
    return [code(path), raw, gzip, code(await digest(path))];
  }),
);
const workerRows = await Promise.all(
  workerFiles.sort(byPath).map(async (path) => {
    const { raw, gzip } = await sizes(path);
    return [code(path), raw, gzip];
  }),
);

const registryRows: Array<ReadonlyArray<string | number>> = [];
for (const path of files("apps/docs/public/r/*.json")) {
  const item = await read(path, RegistryItem);
  for (const embedded of item.files ?? []) {
    const source = `apps/docs/${embedded.path}`;
    const identical = (await readFile(file(source), "utf8")) === embedded.content;
    if (!identical) process.exitCode = 1;
    registryRows.push([code(source), code(path), identical ? "Yes" : "No"]);
  }
}

const entry = "virtual:local-first-worker";
const workerSource = new URL(
  "../../formats/react/__tests__/local-machine.worker.ts",
  import.meta.url,
);
const bundle = await build({
  root: root.pathname,
  configFile: false,
  logLevel: "error",
  plugins: [
    {
      name: "local-first-worker-entry",
      resolveId: (id) => (id === entry ? `\0${entry}` : undefined),
      load: (id) =>
        id === `\0${entry}`
          ? `import Worker from ${JSON.stringify(`${workerSource.pathname}?worker`)}; new Worker();`
          : undefined,
    },
  ],
  worker: { format: "es" },
  build: { write: false, rolldownOptions: { input: entry } },
});
const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((output) =>
  "output" in output ? output.output : [],
);
const spikeRows = chunks
  .filter((chunk) => chunk.fileName.includes("local-machine.worker"))
  .map((chunk) => {
    const content = chunk.type === "asset" ? chunk.source : chunk.code;
    const { raw, gzip } = size(
      typeof content === "string" ? new TextEncoder().encode(content) : content,
    );
    return [code(chunk.fileName), raw, gzip];
  });
if (spikeRows.length === 0) process.exitCode = 1;

console.log(
  [
    "### Published packages",
    table(
      ["Package", "Dist files", "Raw bytes", "Gzip bytes", "Runtime dependencies", "Peers"],
      packageRows,
    ),
    "### Published export subpaths",
    table(["Specifier", "Published target", "Workspace source or build script"], exportRows),
    "### WASM files",
    table(["Path", "Raw bytes", "Gzip bytes", "SHA-256"], wasmRows),
    "### Existing worker entries and emitted chunks",
    table(["Path", "Raw bytes", "Gzip bytes"], workerRows),
    "### Embedded registry source",
    table(["Source", "Generated payload", "Exact match"], registryRows),
    "### Spike production worker",
    table(["Vite chunk", "Raw bytes", "Gzip bytes"], spikeRows),
  ].join("\n\n"),
);
