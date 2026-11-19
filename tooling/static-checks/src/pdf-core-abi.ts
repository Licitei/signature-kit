import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { parseSourceFile } from "./source-context";

export type PdfCoreAbiDiagnostic = {
  readonly path: string;
  readonly message: string;
};

const rustAbiPaths = ["shared/pdf-core/rust/src/abi.rs", "shared/pdf-core/rust/src/edit.rs"];
const decoderPath = "shared/pdf-core/src/pdf-core.ts";
const readmePath = "shared/pdf-core/README.md";

const payloadSections: Record<string, string> = {
  VERSION: "Payload",
  INFO_VERSION: "Info payload",
  TEXT_VERSION: "Text payload",
  HEADINGS_VERSION: "Headings payload",
  TABLES_VERSION: "Tables payload",
  SIGNATURES_VERSION: "Signatures payload",
  DOCUMENT_VERSION: "Document payload",
  METRICS_VERSION: "Font metrics payload",
  EDIT_VERSION: "Edit payload",
  RENDER_VERSION: "Render payload",
};

const isAbiConstant = (name: string): boolean =>
  /^(?:(?:\w+_)?(?:MAGIC|VERSION)|(?:FLAG|PROFILE)_\w+)$/.test(name);

const parseRustValue = (literal: string): number => {
  const shift = /^1 << (\d+)$/.exec(literal);
  return shift === null ? Number(literal.replaceAll("_", "")) : 2 ** Number(shift[1]);
};

const rustConstants = (rootDirectory: string): ReadonlyMap<string, readonly number[]> => {
  const constants = new Map<string, number[]>();
  for (const path of rustAbiPaths) {
    const source = readFileSync(join(rootDirectory, path), "utf8");
    for (const [, name = "", literal = ""] of source.matchAll(
      /^(?:pub(?:\([a-z]+\))? )?const ([A-Z][A-Z0-9_]*): u32 = (0x[0-9A-Fa-f_]+|[0-9_]+|1 << \d+);/gm,
    )) {
      constants.set(name, [...(constants.get(name) ?? []), parseRustValue(literal)]);
    }
  }
  return constants;
};

const decoderConstants = (source: string): ReadonlyMap<string, number> => {
  const constants = new Map<string, number>();
  for (const statement of parseSourceFile(decoderPath, source).statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ts.isNumericLiteral(declaration.initializer)
      ) {
        constants.set(declaration.name.text, Number(declaration.initializer.text));
      }
    }
  }
  return constants;
};

export const collectPdfCoreAbiDiagnostics = (
  rootDirectory = process.cwd(),
): readonly PdfCoreAbiDiagnostic[] => {
  const files = [decoderPath, readmePath, ...rustAbiPaths];
  const missing = files.filter((path) => !existsSync(join(rootDirectory, path)));
  if (missing.length > 0) {
    return missing.map((path) => ({ path, message: "pdf-core ABI file is missing." }));
  }
  const diagnostics: PdfCoreAbiDiagnostic[] = [];
  const rust = rustConstants(rootDirectory);
  const decoder = decoderConstants(readFileSync(join(rootDirectory, decoderPath), "utf8"));

  for (const [name, value] of decoder) {
    const values = rust.get(name) ?? [];
    if (isAbiConstant(name) && (values.length !== 1 || values[0] !== value)) {
      diagnostics.push({
        path: decoderPath,
        message: `${name} is ${value} in the decoder but [${values.join(", ")}] in ${rustAbiPaths.join(" and ")}.`,
      });
    }
  }

  const readme = readFileSync(join(rootDirectory, readmePath), "utf8");
  const sections = new Map<
    string,
    { readonly version: string | undefined; readonly body: string }
  >();
  for (const section of readme.split(/^(?=### )/m).filter((part) => part.startsWith("### "))) {
    const heading = /^### (.*payload)(?: \(version (\d+)\))?$/im.exec(section);
    if (heading !== null) {
      sections.set(heading[1] ?? "", { version: heading[2], body: section });
    }
  }
  for (const [constant, title] of Object.entries(payloadSections)) {
    const expected = decoder.get(constant);
    if (expected === undefined) {
      continue;
    }
    const section = sections.get(title);
    const versions =
      section === undefined
        ? []
        : [
            section.version,
            ...[...section.body.matchAll(/`version` \(`(\d+)`\)/g)].map((match) => match[1]),
          ];
    if (versions.length === 0 || versions.some((version) => Number(version) !== expected)) {
      diagnostics.push({
        path: readmePath,
        message: `"### ${title} (version N)" must exist and document ${constant} (${expected}), found [${versions.join(", ")}].`,
      });
    }
  }

  const flags = /^`flags`: (.+)$/m.exec(readme)?.[1] ?? "";
  const documented = [...flags.matchAll(/bit (\d+) =/g)]
    .map((match) => Number(match[1]))
    .sort((left: number, right: number) => left - right);
  const declared = [...decoder]
    .filter(([name]) => name.startsWith("FLAG_"))
    .map(([, value]) => Math.log2(value))
    .sort((left: number, right: number) => left - right);
  if (documented.join() !== declared.join()) {
    diagnostics.push({
      path: readmePath,
      message: `\`flags\` documents bits [${documented.join(", ")}] but the decoder declares [${declared.join(", ")}].`,
    });
  }
  return diagnostics;
};

export const runPdfCoreAbiChecks = (rootDirectory = process.cwd()): boolean => {
  const diagnostics = collectPdfCoreAbiDiagnostics(rootDirectory);
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.path}: ${diagnostic.message}`);
  }
  if (diagnostics.length > 0) {
    console.error(
      "pdf-core ABI check failed. Keep the Rust ABI constants, the pdf-core.ts decoder and the README payload sections in lockstep.",
    );
  }
  return diagnostics.length > 0;
};
