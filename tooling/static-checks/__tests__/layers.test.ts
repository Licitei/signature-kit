import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWorkspaceLayerDiagnostics } from "../src/layers";

const temporaryRoots: string[] = [];

const createTempWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "signature-kit-layers-"));
  temporaryRoots.push(root);
  return root;
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const writePackage = async (
  root: string,
  directory: string,
  name: string,
  dependencies: Record<string, string>,
  references: readonly string[],
  source: string,
): Promise<void> => {
  const packageDirectory = join(root, directory);
  await mkdir(join(packageDirectory, "src"), { recursive: true });
  await writeJson(join(packageDirectory, "package.json"), {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
  });
  await writeJson(join(packageDirectory, "tsconfig.json"), {
    extends: "../../tooling/typescript/core.json",
    include: ["src/**/*.ts"],
    references: references.map((path) => ({ path })),
  });
  await writeFile(join(packageDirectory, "src/index.ts"), source);
};

const writeBaseConfig = async (
  root: string,
  paths: Record<string, readonly string[]>,
): Promise<void> => {
  await mkdir(join(root, "tooling/typescript"), { recursive: true });
  await writeJson(join(root, "tooling/typescript/base.json"), {
    compilerOptions: { paths },
  });
};

afterEach(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true });
  }
  temporaryRoots.length = 0;
});

describe("workspace layer checks", () => {
  it("accepts the current repository package graph", () => {
    expect(collectWorkspaceLayerDiagnostics()).toEqual([]);
  });

  it("rejects runtime dependencies from engine to browser", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/browser",
      "@signature-kit/browser",
      {},
      [],
      "export const signatures = true;\n",
    );
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      { "@signature-kit/browser": "workspace:*" },
      ["../browser"],
      "import { signatures } from '@signature-kit/browser';\nexport const value = signatures;\n",
    );

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "packages/engine/package.json",
      message: "@signature-kit/engine (engine) cannot depend on @signature-kit/browser (browser).",
    });
  });

  it("checks app imports through package subpaths without requiring project references", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const pem = true;\n",
    );
    await mkdir(join(root, "apps/docs/app"), { recursive: true });
    await writeJson(join(root, "apps/docs/package.json"), {
      name: "@signature-kit/docs",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: {},
    });
    await writeFile(
      join(root, "apps/docs/app/page.ts"),
      "import { pem } from '@signature-kit/engine/pem';\nexport const value = pem;\n",
    );

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "apps/docs/app/page.ts",
      message:
        "@signature-kit/docs imports @signature-kit/engine without declaring it in package.json.",
    });
  });

  it("ignores Foldkit build output while checking the same import in source", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const crypto = true;\n",
    );
    await mkdir(join(root, "apps/docs/foldkit"), { recursive: true });
    await mkdir(join(root, "apps/docs/foldkit/dist-foldkit"), { recursive: true });
    await mkdir(join(root, "apps/docs/foldkit/paraglide"), { recursive: true });
    await mkdir(join(root, "apps/docs/dist-foldkit/client/assets"), { recursive: true });
    await mkdir(join(root, "apps/docs/dist-foldkit/server"), { recursive: true });
    await writeJson(join(root, "apps/docs/package.json"), {
      name: "@signature-kit/docs",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: {},
    });
    const invalidImport = 'import "@signature-kit/engine";\n';
    await writeFile(join(root, "apps/docs/foldkit/main.ts"), invalidImport);
    await writeFile(join(root, "apps/docs/foldkit/dist-foldkit/source.ts"), invalidImport);
    await writeFile(join(root, "apps/docs/foldkit/paraglide/source.ts"), invalidImport);
    await writeFile(join(root, "apps/docs/dist-foldkit/client/assets/app.js"), invalidImport);
    await writeFile(join(root, "apps/docs/dist-foldkit/server/fetch.mjs"), invalidImport);
    const diagnostics = collectWorkspaceLayerDiagnostics(root);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "apps/docs/foldkit/dist-foldkit/source.ts",
          message:
            "@signature-kit/docs imports @signature-kit/engine without declaring it in package.json.",
        },
        {
          path: "apps/docs/foldkit/main.ts",
          message:
            "@signature-kit/docs imports @signature-kit/engine without declaring it in package.json.",
        },
        {
          path: "apps/docs/foldkit/paraglide/source.ts",
          message:
            "@signature-kit/docs imports @signature-kit/engine without declaring it in package.json.",
        },
      ]),
    );
  });

  it("requires package dependencies and tsconfig references to stay aligned", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const asn1 = true;\n",
    );
    await writePackage(
      root,
      "packages/browser",
      "@signature-kit/browser",
      { "@signature-kit/engine": "workspace:*" },
      [],
      "import { asn1 } from '@signature-kit/engine';\nexport const value = asn1;\n",
    );

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "packages/browser/tsconfig.json",
      message:
        "@signature-kit/browser depends on @signature-kit/engine but does not reference its tsconfig project.",
    });
  });

  it("rejects relative imports into another workspace package", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/browser",
      "@signature-kit/browser",
      {},
      [],
      "export const signer = true;\n",
    );
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "import { signer } from '../../browser/src/index.js';\nexport const value = signer;\n",
    );

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "packages/engine/src/index.ts",
      message:
        "@signature-kit/engine reaches into @signature-kit/browser through a relative import; import the package entry point instead.",
    });
  });

  it("requires package exports to resolve through source path aliases", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const index = true;\n",
    );
    await writeFile(join(root, "packages/engine/src/pem.ts"), "export const pem = true;\n");
    await writeJson(join(root, "packages/engine/package.json"), {
      name: "@signature-kit/engine",
      version: "0.0.0",
      private: true,
      type: "module",
      exports: {
        "./pem": {
          import: "./dist/pem.js",
          types: "./dist/pem.d.ts",
        },
      },
      dependencies: {},
    });
    await writeBaseConfig(root, {});

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "tooling/typescript/base.json",
      message:
        "@signature-kit/engine/pem is exported by @signature-kit/engine but does not resolve to packages/engine/src/pem.ts in tooling/typescript/base.json.",
    });
  });

  it("rejects committed dist modules without matching source", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const index = true;\n",
    );
    await mkdir(join(root, "packages/engine/dist"), { recursive: true });
    await writeFile(join(root, "packages/engine/dist/hash.js"), "export const hash = true;\n");
    await writeBaseConfig(root, {});

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "packages/engine/dist/hash.js",
      message:
        "packages/engine/dist/hash.js is committed generated output without a matching source module.",
    });
  });
  it("parses side-effect imports for package dependency diagnostics", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const dep = true;\n",
    );
    await writePackage(
      root,
      "packages/browser",
      "@signature-kit/browser",
      {},
      [],
      'import "@signature-kit/engine";\nexport const use = true;\n',
    );

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "packages/browser/src/index.ts",
      message:
        "@signature-kit/browser imports @signature-kit/engine without declaring it in package.json.",
    });
  });

  it("rejects path aliases that do not have a package export", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const crypto = true;\n",
    );
    await writeFile(join(root, "packages/engine/src/pem.ts"), "export const pem = true;\n");
    await writeBaseConfig(root, {
      "@signature-kit/engine/pem": ["../../packages/engine/src/pem.ts"],
    });

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "tooling/typescript/base.json",
      message:
        "@signature-kit/engine/pem is configured as a path alias but is not exported by @signature-kit/engine.",
    });
  });

  it("requires explicit runtime extensions for library relative imports", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      'import "./pem";\nexport const crypto = true;\n',
    );
    await writeFile(join(root, "packages/engine/src/pem.ts"), "export const pem = true;\n");

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "packages/engine/src/index.ts",
      message:
        "packages/engine/src/index.ts uses extensionless relative import ./pem; emitted library modules must use an explicit .js, .mjs, .cjs, .json, or asset extension.",
    });
  });
  it("rejects exported dist entries that have no source module", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const crypto = true;\n",
    );
    await writeJson(join(root, "packages/engine/package.json"), {
      name: "@signature-kit/engine",
      version: "0.0.0",
      private: true,
      type: "module",
      exports: {
        "./missing": { import: "./dist/missing.js" },
      },
      dependencies: {},
    });
    await writeBaseConfig(root, {
      "@signature-kit/engine/missing": ["../../packages/engine/src/missing.ts"],
    });

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "packages/engine/package.json",
      message:
        "@signature-kit/engine/missing is exported by @signature-kit/engine but has no matching source module.",
    });
  });

  it("applies dependency-reference lockstep to application packages", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const dep = true;\n",
    );
    await mkdir(join(root, "apps/docs"), { recursive: true });
    await writeJson(join(root, "apps/docs/package.json"), {
      name: "@signature-kit/docs",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { "@signature-kit/engine": "workspace:*" },
    });
    await writeJson(join(root, "apps/docs/tsconfig.json"), {
      extends: "../../tooling/typescript/core.json",
      references: [],
    });

    expect(collectWorkspaceLayerDiagnostics(root)).toContainEqual({
      path: "apps/docs/tsconfig.json",
      message:
        "@signature-kit/docs depends on @signature-kit/engine but does not reference its tsconfig project.",
    });
  });

  it("ignores imports mentioned only in comments", async () => {
    const root = await createTempWorkspace();
    await writePackage(
      root,
      "packages/engine",
      "@signature-kit/engine",
      {},
      [],
      "export const dep = true;\n",
    );
    await writePackage(
      root,
      "packages/browser",
      "@signature-kit/browser",
      {},
      [],
      "// import '@signature-kit/engine';\n/* from '@signature-kit/engine' */\nexport const use = true;\n",
    );

    expect(collectWorkspaceLayerDiagnostics(root)).toEqual([]);
  });
});
