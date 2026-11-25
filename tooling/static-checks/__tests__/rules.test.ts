import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check } from "../src/model";
import { roots } from "../src/config";
import { checks } from "../src/rule-set";
import { schemaContractChecks } from "../src/rules/schema-contracts";
import { errorHandlingChecks } from "../src/rules/error-handling";
import { typeSafetyChecks } from "../src/rules/type-safety";
import { effectBoundaryChecks } from "../src/rules/effect-boundaries";
import { observabilityCatalogChecks } from "../src/rules/observability-catalogs";
import { configChecks } from "../src/rules/config";
import { dependencyChecks } from "../src/rules/dependencies";
import { hasCheckedExtension, shouldSkip } from "../src/filesystem";
import {
  importDeclarationLineMap,
  runDeclarativeChecks,
  runFileDeclarativeChecks,
} from "../src/runner";
import { createCheckContexts } from "../src/source-context";

const expectedChecks = [
  ...schemaContractChecks,
  ...errorHandlingChecks,
  ...typeSafetyChecks,
  ...effectBoundaryChecks,
  ...observabilityCatalogChecks,
  ...configChecks,
  ...dependencyChecks,
];

const context = (line: string) => {
  const first = createCheckContexts("packages/example/src/index.ts", line)[0];
  if (first === undefined) {
    throw new Error("fixture context missing");
  }
  return first;
};

const anyCheckMatches = (checks: readonly Check[], line: string): boolean =>
  checks.some((check) => check.test(context(line)));

const anyCheckMatchesSource = (checks: readonly Check[], path: string, source: string): boolean => {
  const contexts = createCheckContexts(path, source);
  const sourceFile = contexts[0]?.sourceFile;
  if (sourceFile === undefined) {
    return false;
  }
  const importLines = importDeclarationLineMap(
    contexts.map((item) => item.rawLine),
    sourceFile,
  );
  return contexts.some(
    (item, index) =>
      item.line !== "" &&
      !item.line.startsWith("*") &&
      !item.line.startsWith("//") &&
      checks.some((check) => (!check.ignoreImportLine || !importLines[index]) && check.test(item)),
  );
};

describe("declarative smell rules", () => {
  it("registers every authored check in the composed rule set", () => {
    expect(checks.map((check) => check.message)).toEqual(
      expectedChecks.map((check) => check.message),
    );
  });

  it("rejects instanceof error and cause classification", () => {
    for (const line of [
      "if (cause instanceof Error) return cause.message;",
      "if (cause instanceof DOMException) return cause.name;",
      "if (error instanceof RemoteFailure) return error.code;",
      "if (error instanceof vendor.TransportFault) return error.code;",
      "if (error instanceof ValidationException) return error.code;",
    ]) {
      expect(anyCheckMatches(errorHandlingChecks, line)).toBe(true);
    }
  });

  it("allows instanceof for structural parsed-node discrimination", () => {
    for (const line of [
      "if (object instanceof PDFNumber) return object.asNumber();",
      "if (value instanceof asn1js.Sequence) return value.valueBlock.value;",
    ]) {
      expect(anyCheckMatches(errorHandlingChecks, line)).toBe(false);
    }
  });

  it("rejects generic cause metadata wrappers", () => {
    expect(
      anyCheckMatches(errorHandlingChecks, "export const safeCauseMetadata = () => ({})"),
    ).toBe(true);
  });

  it("rejects schema issue string laundering", () => {
    expect(anyCheckMatches(errorHandlingChecks, "reason: String(issue),")).toBe(true);
  });

  it("rejects message-only error laundering", () => {
    expect(anyCheckMatches(errorHandlingChecks, "reason: error.message,")).toBe(true);
    expect(anyCheckMatches(errorHandlingChecks, "cause: cause.message,")).toBe(true);
    expect(anyCheckMatches(errorHandlingChecks, "message: unknown.message,")).toBe(true);
    expect(anyCheckMatches(errorHandlingChecks, "issueMessage: String(issue),")).toBe(false);
    expect(anyCheckMatches(errorHandlingChecks, "reason: error.reason ?? error.message,")).toBe(
      false,
    );
  });

  it("requires catalog values for domain code, operation, and phase strings", () => {
    for (const line of [
      'code: "document.invalid",',
      'operation: "document.verify",',
      'phase: "DocumentVerification",',
    ]) {
      expect(anyCheckMatches(observabilityCatalogChecks, line)).toBe(true);
    }
  });

  it("allows ordinary names outside observability catalogs", () => {
    expect(anyCheckMatches(observabilityCatalogChecks, 'name: "document.pdf",')).toBe(false);
  });

  it("rejects all TypeScript as casts including const assertions", () => {
    expect(anyCheckMatches(typeSafetyChecks, "const codes = ['A'] as const;")).toBe(true);
  });

  it("scans test files for casts without general exceptions", () => {
    expect(
      anyCheckMatchesSource(
        typeSafetyChecks,
        "packages/example/__tests__/fixture.test.ts",
        "const value = input as unknown;",
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        typeSafetyChecks,
        "packages/example/__tests__/fixture.test.ts",
        "const values = ['ok'] as const;",
      ),
    ).toBe(true);
  });

  it("rejects throwing even a typed SignatureKit error from library code", () => {
    expect(
      anyCheckMatchesSource(
        errorHandlingChecks,
        "packages/example/src/runtime.ts",
        "throw new SignatureKitError({ code: 'invalid' });",
      ),
    ).toBe(true);
  });

  it("rejects try/finally in test files while preserving assertion throws", () => {
    expect(
      anyCheckMatchesSource(
        errorHandlingChecks,
        "packages/example/__tests__/fixture.test.ts",
        "try { await run(); } finally { cleanup(); }",
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        errorHandlingChecks,
        "packages/example/__tests__/fixture.test.ts",
        'throw new Error("expected failure");',
      ),
    ).toBe(false);
  });

  it("allows Effect.as because it is a method call, not a TypeScript cast", () => {
    expect(anyCheckMatches(typeSafetyChecks, "Effect.as({ ok: true })")).toBe(false);
  });

  it("does not treat aliases in multiline imports as TypeScript casts", () => {
    expect(
      anyCheckMatchesSource(
        typeSafetyChecks,
        "packages/engine/src/engine.ts",
        `import {
  Certificate as ParsedCertificate,
} from "@signature-kit/certificates";`,
      ),
    ).toBe(false);
  });
  it("requires reasoned Effect run escapes in docs paths", () => {
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "apps/docs/src/hooks.ts",
        `
// effect-boundary: docs event action [allow-run: hook event-action boundary]
const result = await Effect.runPromise(program);
`,
      ),
    ).toBe(false);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "apps/docs/src/hooks.ts",
        `
// effect-boundary: docs event action [allow-run]
const result = await Effect.runPromise(program);
`,
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/engine/src/certificates/signatures.ts",
        `
// effect-boundary: docs event action [allow-run: hook event-action boundary]
const result = await Effect.runPromise(program);
`,
      ),
    ).toBe(true);
  });

  it.each([
    ["packages/engine/src/wasm/promise.ts", false],
    ["packages/engine/src/wasm/node.ts", false],
    ["packages/engine/src/wasm/pdf-core.ts", true],
  ])("limits Promise entry run escapes and node imports to their modules (%s)", (path, flagged) => {
    const run = `
// effect-boundary: promise entry point [allow-run: rejects with the tagged error]
const client = Effect.runPromise(program);
`;
    expect(anyCheckMatchesSource(effectBoundaryChecks, path, run)).toBe(flagged);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        path,
        'import { readFile } from "node:fs/promises";',
      ),
    ).toBe(path !== "packages/engine/src/wasm/node.ts");
  });

  it("requires a reasoned provide marker immediately before a docs provide call", () => {
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "apps/docs/src/hooks.ts",
        `
// effect-boundary: browser worker injection [allow-provide: browser worker layer boundary]
Effect.provide(Layer.empty);
`,
      ),
    ).toBe(false);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "apps/docs/src/hooks.ts",
        `
// effect-boundary: browser worker injection [allow-provide]
Effect.provide(Layer.empty);
`,
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "apps/docs/src/hooks.ts",
        `
// effect-boundary: browser worker injection [allow-provide: browser worker layer boundary]
const program = Effect.void;
Effect.provide(Layer.empty);
`,
      ),
    ).toBe(true);
  });

  it("rejects deprecated Effect either/effect and dynamic imports in library source", () => {
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/engine/src/certificates/runtime.ts",
        "const result = Effect.either(program);",
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/engine/src/certificates/runtime.ts",
        'const module = import("./runtime-helper");',
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/engine/src/certificates/runtime.ts",
        "const module = import(moduleName);",
      ),
    ).toBe(false);
  });

  it("rejects named Effect escapes and direct Node platform imports only in library source", () => {
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/engine/src/certificates/runtime.ts",
        'import { runPromise } from "effect";\nconst result = runPromise(program);',
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/engine/src/certificates/runtime.ts",
        'import { readFile } from "node:fs/promises";',
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "apps/docs/app/page.ts",
        'import { readFile } from "node:fs/promises";',
      ),
    ).toBe(false);
  });

  it("requires reasoned secret escapes in docs paths", () => {
    expect(
      anyCheckMatchesSource(
        configChecks,
        "apps/docs/src/config.ts",
        `
const CredentialsSchema = Schema.Struct({
  // secret-boundary: UI password import boundary [allow-string-secret: hook event-action boundary]
  password: Schema.String,
});
`,
      ),
    ).toBe(false);
    expect(
      anyCheckMatchesSource(
        configChecks,
        "apps/docs/src/config.ts",
        `
const CredentialsSchema = Schema.Struct({
  // secret-boundary: UI password import boundary [allow-string-secret]
  password: Schema.String,
});
`,
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        configChecks,
        "packages/engine/src/certificates/signatures.ts",
        `
const CredentialsSchema = Schema.Struct({
  // secret-boundary: UI password import boundary [allow-string-secret: hook event-action boundary]
  password: Schema.String,
});
`,
      ),
    ).toBe(true);
  });
  it("scans package manifests so dependency checks are live", () => {
    expect(hasCheckedExtension("packages/engine/package.json")).toBe(true);
  });

  it("flags public package scripts that shadow inferred TypeScript targets", () => {
    expect(
      anyCheckMatchesSource(
        dependencyChecks,
        "packages/engine/package.json",
        `
{
  "name": "@signature-kit/engine",
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
`,
      ),
    ).toBe(true);
  });

  it("allows non-TypeScript package scripts and application build scripts", () => {
    expect(
      anyCheckMatchesSource(
        dependencyChecks,
        "packages/engine/package.json",
        `
{
  "name": "@signature-kit/engine",
  "scripts": {
    "test": "vitest run"
  }
}
`,
      ),
    ).toBe(false);
    expect(
      anyCheckMatchesSource(
        dependencyChecks,
        "apps/docs/package.json",
        `
{
  "name": "@signature-kit/docs",
  "scripts": {
    "build": "waku build",
    "types:check": "tsc -p tsconfig.json --noEmit"
  }
}
`,
      ),
    ).toBe(false);
  });

  it("uses stateful comment normalization for multiline blocks", () => {
    expect(
      anyCheckMatchesSource(
        errorHandlingChecks,
        "packages/example/src/comments.ts",
        "/*\nthrow new Error('comment');\ntry {\n}\n*/\nexport const value = true;\n",
      ),
    ).toBe(false);
    expect(
      anyCheckMatchesSource(
        errorHandlingChecks,
        "packages/example/src/runtime.ts",
        "try\n{\n  run();\n}\n",
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        errorHandlingChecks,
        "packages/example/src/runtime.ts",
        "throw\nnew SignatureKitError({ code: 'invalid' });\n",
      ),
    ).toBe(true);
  });

  it("matches exact Effect member calls and named bindings", () => {
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/example/src/runtime.ts",
        'import { runPromise } from "effect";\nclient.runPromise(program);\nEffect.effectfulApi(program);\nEffect.eitherThing(program);\n',
      ),
    ).toBe(false);
    expect(
      anyCheckMatchesSource(
        effectBoundaryChecks,
        "packages/example/src/runtime.ts",
        'import { runPromise } from "effect";\nrunPromise(program);\n',
      ),
    ).toBe(true);
  });

  it("rejects multiline literal arrays and fake schema bindings", () => {
    expect(
      anyCheckMatchesSource(
        schemaContractChecks,
        "packages/example/src/contracts.ts",
        "const StatusCodes = [\n  'pending',\n  'complete',\n];\n",
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        schemaContractChecks,
        "packages/example/src/contracts.ts",
        "export interface ExampleConfig {\n  enabled: boolean;\n}\nconst ExampleConfigSchema = 1;\n",
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        schemaContractChecks,
        "packages/example/src/contracts.ts",
        "export interface ExampleConfig {\n  enabled: boolean;\n}\nconst ExampleConfigSchema = Schema.Struct({ enabled: Schema.Boolean });\n",
      ),
    ).toBe(false);
  });

  it("rejects inline import type annotations", () => {
    expect(
      anyCheckMatchesSource(
        typeSafetyChecks,
        "packages/example/src/runtime.ts",
        'const value: import("@signature-kit/certificates").Certificate = input;\n',
      ),
    ).toBe(true);
    expect(
      anyCheckMatchesSource(
        typeSafetyChecks,
        "packages/example/src/runtime.ts",
        'import type { Certificate } from "@signature-kit/certificates";\nconst value: Certificate = input;\n',
      ),
    ).toBe(false);
  });

  it("selects the local runtime and applies library boundary rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "signature-kit-runtime-selection-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const packagesRoot = "packages";
    const packageRoot = "packages/browser";
    expect(roots).toContain(packagesRoot);
    await mkdir(join(root, packageRoot, "src"), { recursive: true });
    await writeFile(join(root, packageRoot, "src/signing.ts"), "Effect.runPromise(program);\n");
    expect(
      runDeclarativeChecks(
        root,
        roots.filter((path) => path === packagesRoot),
      ),
    ).toBe(true);
    expect(
      runFileDeclarativeChecks(
        join(root, "apps/docs/src/page.ts"),
        "Effect.runPromise(program);\n",
        root,
      ),
    ).toBe(false);
    expect(
      runFileDeclarativeChecks(
        join(root, packageRoot, "src/signing.ts"),
        "// [allow-run: fixture]\nEffect.runPromise(program);\n",
        root,
      ),
    ).toBe(true);
  });

  it("skips package tooling directories but keeps library sources and tests", () => {
    for (const path of [
      "packages/engine/scripts/generate-font-tables.ts",
      "packages/engine/scripts/generate-corpus.ts",
      "packages/engine/bench/measure-speed.ts",
      "packages/engine/scripts/capture-anchor-goldens.ts",
      "/repo/packages/engine/scripts/render-corpus.ts",
    ]) {
      expect(shouldSkip(path)).toBe(true);
    }
    for (const path of [
      "packages/engine/src/wasm/pdf-core.ts",
      "packages/engine/__tests__/text-anchors-golden.test.ts",
      "packages/engine/src/wasm/scripts/anchors.ts",
      "packages/engine/src/certificates/bench.ts",
    ]) {
      expect(shouldSkip(path)).toBe(false);
    }
  });

  it("runs fixtures through the declarative entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "signature-kit-static-"));
    const file = join(root, "packages/example/src/index.ts");
    await mkdir(join(root, "packages/example/src"), { recursive: true });
    await writeFile(
      file,
      "/*\nthrow new Error('comment');\nimport '@signature-kit/unused';\n*/\nexport const value = true;\n",
    );
    expect(runDeclarativeChecks(root, [file])).toBe(false);
    const badFile = join(root, "packages/example/src/bad.ts");
    await writeFile(badFile, "throw\nnew SignatureKitError({ code: 'invalid' });\n");
    expect(runDeclarativeChecks(root, [badFile])).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
