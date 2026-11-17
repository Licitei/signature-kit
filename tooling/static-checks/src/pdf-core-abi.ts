import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { parseSourceFile } from "./source-context";

export type PdfCoreAbiDiagnostic = {
  readonly path: string;
  readonly message: string;
};

const rustSourceDirectory = "shared/pdf-core/rust/src";
const decoderPath = "shared/pdf-core/src/pdf-core.ts";
const readmePath = "shared/pdf-core/README.md";

const payloadVersionConstants: Record<string, string> = {
  "": "VERSION",
  Text: "TEXT_VERSION",
  Tables: "TABLES_VERSION",
  Signatures: "SIGNATURES_VERSION",
  Document: "DOCUMENT_VERSION",
  "Font metrics": "METRICS_VERSION",
  Edit: "EDIT_VERSION",
  Render: "RENDER_VERSION",
};

const rustConstants = (rootDirectory: string): ReadonlyMap<string, ReadonlySet<number>> => {
  const constants = new Map<string, Set<number>>();
  const directory = join(rootDirectory, rustSourceDirectory);
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".rs"))) {
    const source = readFileSync(join(directory, file), "utf8");
    for (const match of source.matchAll(
      /^(?:pub\(crate\) )?const ([A-Z][A-Z0-9_]*): u32 = (0x[0-9A-Fa-f_]+|[0-9_]+);/gm,
    )) {
      const [, name, literal] = match;
      if (name === undefined || literal === undefined) {
        continue;
      }
      const values = constants.get(name) ?? new Set<number>();
      values.add(Number(literal.replaceAll("_", "")));
      constants.set(name, values);
    }
  }
  return constants;
};

const decoderConstants = (rootDirectory: string): ReadonlyMap<string, number> => {
  const sourceFile = parseSourceFile(
    decoderPath,
    readFileSync(join(rootDirectory, decoderPath), "utf8"),
  );
  const constants = new Map<string, number>();
  for (const statement of sourceFile.statements) {
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
  if (!existsSync(join(rootDirectory, decoderPath))) {
    return [];
  }
  const diagnostics: PdfCoreAbiDiagnostic[] = [];
  const rust = rustConstants(rootDirectory);
  const decoder = decoderConstants(rootDirectory);

  for (const [name, value] of decoder) {
    const values = rust.get(name);
    if (values === undefined) {
      continue;
    }
    if (values.size !== 1 || !values.has(value)) {
      diagnostics.push({
        path: decoderPath,
        message: `${name} is ${value} in the decoder but ${[...values].join(", ")} in ${rustSourceDirectory}.`,
      });
    }
  }

  const readme = readFileSync(join(rootDirectory, readmePath), "utf8");
  const sections = readme.split(/^(?=### )/m);
  for (const section of sections) {
    const heading = /^### (?:(.+?) payload|Payload) \(version (\d+)\)/.exec(section);
    if (heading === null) {
      continue;
    }
    const [, label = "", version = ""] = heading;
    const constant = payloadVersionConstants[label];
    const expected = constant === undefined ? undefined : decoder.get(constant);
    if (expected === undefined) {
      diagnostics.push({
        path: readmePath,
        message: `"${heading[0]}" has no matching *_VERSION constant in the decoder.`,
      });
      continue;
    }
    for (const documented of [
      version,
      ...[...section.matchAll(/`version` \(`(\d+)`\)/g)].map((match) => match[1]),
    ]) {
      if (Number(documented) !== expected) {
        diagnostics.push({
          path: readmePath,
          message: `"${heading[0]}" documents version ${documented}, but ${constant} is ${expected}.`,
        });
      }
    }
  }

  const flags = /^`flags`: (.+)$/m.exec(readme)?.[1] ?? "";
  const documentedBits = new Set(
    [...flags.matchAll(/bit (\d+) =/g)].map((match) => Number(match[1])),
  );
  for (const [name, value] of decoder) {
    if (!name.startsWith("FLAG_") || !rust.has(name)) {
      continue;
    }
    const bit = Math.log2(value);
    if (!documentedBits.has(bit)) {
      diagnostics.push({
        path: readmePath,
        message: `${name} (bit ${bit}) is missing from the documented \`flags\` bits.`,
      });
    }
  }
  return diagnostics;
};

export const runPdfCoreAbiChecks = (rootDirectory = process.cwd()): boolean => {
  const diagnostics = collectPdfCoreAbiDiagnostics(rootDirectory);
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.path}:1: ${diagnostic.message}`);
    console.error(
      "pdf-core ABI check failed. Keep abi.rs, the pdf-core.ts decoder and the README payload sections in lockstep.",
    );
  }
  return diagnostics.length > 0;
};
