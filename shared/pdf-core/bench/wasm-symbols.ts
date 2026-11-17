#!/usr/bin/env bun
/**
 * Parse a wasm module's code + optional name section and list function sizes.
 * Prefer an unstripped build (`strip = false`) so the name section is present.
 * Usage: bun shared/pdf-core/bench/wasm-symbols.ts [wasm-path] [--top N]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const repo = resolve(pkg, "../..");
const args: string[] = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const topN = topIdx >= 0 ? Number(args[topIdx + 1] ?? 60) : 60;
const pathArg = args.find((argument, index) => {
  if (argument.startsWith("--")) {
    return false;
  }
  if (index === 0) {
    return true;
  }
  const previous = args[index - 1];
  return previous === undefined || previous.startsWith("--") === false;
});
const wasmPath = resolve(pathArg ?? join(pkg, "dist/pdf-core.wasm"));

const data = new Uint8Array(readFileSync(wasmPath));

function readLeb(offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    pos += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, next: pos };
}

function readName(offset: number): { name: string; next: number } {
  const { value: len, next } = readLeb(offset);
  const bytes = data.subarray(next, next + len);
  return { name: new TextDecoder().decode(bytes), next: next + len };
}

type Section = { id: number; size: number; start: number };
const sections: Section[] = [];
let off = 8;
while (off < data.length) {
  const id = data[off];
  off += 1;
  const { value: size, next } = readLeb(off);
  sections.push({ id, size, start: next });
  off = next + size;
}

const customNames = new Map<number, string>();
let importFuncCount = 0;
let declaredFuncCount = 0;
const codeBodies: { size: number; start: number }[] = [];

for (const section of sections) {
  if (section.id === 0) {
    const { name, next } = readName(section.start);
    if (name === "name") {
      let pos = next;
      const end = section.start + section.size;
      while (pos < end) {
        const id = data[pos];
        pos += 1;
        const size = readLeb(pos);
        pos = size.next;
        const subEnd = pos + size.value;
        if (id === 1) {
          const count = readLeb(pos);
          pos = count.next;
          for (let i = 0; i < count.value; i += 1) {
            const idx = readLeb(pos);
            pos = idx.next;
            const nm = readName(pos);
            pos = nm.next;
            customNames.set(idx.value, nm.name);
          }
        }
        pos = subEnd;
      }
    }
  } else if (section.id === 2) {
    let pos = section.start;
    const count = readLeb(pos);
    pos = count.next;
    for (let i = 0; i < count.value; i += 1) {
      const mod = readName(pos);
      pos = mod.next;
      const field = readName(pos);
      pos = field.next;
      const kind = data[pos];
      pos += 1;
      if (kind === 0) {
        importFuncCount += 1;
        const ty = readLeb(pos);
        pos = ty.next;
        void field;
      } else if (kind === 1) {
        pos = readLeb(pos).next;
        pos += 1;
        pos = readLeb(pos).next;
      } else if (kind === 2) {
        pos += 1;
        const hasMax = data[pos];
        pos += 1;
        pos = readLeb(pos).next;
        if (hasMax === 1) pos = readLeb(pos).next;
      } else if (kind === 3) {
        pos = readLeb(pos).next;
        pos += 1;
      }
    }
  } else if (section.id === 3) {
    const count = readLeb(section.start);
    declaredFuncCount = count.value;
  } else if (section.id === 10) {
    let pos = section.start;
    const count = readLeb(pos);
    pos = count.next;
    for (let i = 0; i < count.value; i += 1) {
      const body = readLeb(pos);
      pos = body.next;
      codeBodies.push({ size: body.value, start: pos });
      pos += body.value;
    }
  }
}

type Row = { index: number; name: string; size: number; group: string };
const rows: Row[] = codeBodies.map((body, i) => {
  const index = importFuncCount + i;
  const name = customNames.get(index) ?? `func[${index}]`;
  const group = classify(name);
  return { index, name, size: body.size, group };
});

function classify(name: string): string {
  // Strip the crate path prefix so "signature_kit_pdf_core" does not match "signature".
  const trimmed = name.replace(/signature_kit_pdf_core/g, "");
  const n = trimmed.toLowerCase();
  if (
    /(?:^|[^a-z])(?:font|glyph|cff|cmap|sfnt|type1|truetype|fontprog|font_tables)/.test(n) ||
    (n.includes("ntb") && n.includes("font"))
  )
    return "font";
  if (
    n.includes("4font") ||
    n.includes("8fontprog") ||
    n.includes("3cff") ||
    n.includes("4cmap") ||
    n.includes("5glyph")
  )
    return "font";
  if (
    n.includes("6render") ||
    n.includes("7display") ||
    n.includes("7shading") ||
    n.includes("5color")
  )
    return "render";
  if (n.includes("3png") || n.includes("5image") || n.includes("5ccitt")) return "image";
  if (
    n.includes("7deflate") ||
    n.includes("7inflate") ||
    n.includes("zlib") ||
    n.includes("huffman")
  )
    return "deflate";
  if (n.includes("8revision") || n.includes("byte_range") || n.includes("pdf_core_signatures"))
    return "revision";
  if (
    n.includes("5write") ||
    n.includes("4edit") ||
    n.includes("pdf_core_merge") ||
    n.includes("pdf_core_create") ||
    n.includes("pdf_core_edit")
  )
    return "write";
  if (
    n.includes("8markdown") ||
    n.includes("6layout") ||
    n.includes("5table") ||
    n.includes("4text") ||
    n.includes("pdf_core_text") ||
    n.includes("pdf_core_tables")
  )
    return "text/layout";
  if (
    n.includes("6syntax") ||
    n.includes("8document") ||
    n.includes("6object") ||
    n.includes("7filters") ||
    n.includes("pdf_core_document") ||
    n.includes("pdf_core_inspect")
  )
    return "parse";
  if (
    n.includes("3fmt") ||
    n.includes("5panic") ||
    n.includes("rtformat") ||
    n.includes("formatter") ||
    n.includes("9panicking")
  )
    return "fmt/panic";
  if (
    n.includes("dlmalloc") ||
    n.includes("8dlmalloc") ||
    n.includes("6malloc") ||
    n.includes("5alloc") ||
    n.includes("pdf_core_alloc") ||
    n.includes("pdf_core_free")
  )
    return "alloc";
  if (n.includes("3abi") || n.includes("pdf_core_")) return "abi";
  if (n.includes("5slice4sort") || n.includes("4sort")) return "sorts";
  return "other";
}

rows.sort((a, b) => b.size - a.size);
const groups = new Map<string, number>();
for (const row of rows) groups.set(row.group, (groups.get(row.group) ?? 0) + row.size);

const codeTotal = rows.reduce((a, r) => a + r.size, 0);
const dataSection = sections.find((s) => s.id === 11);
const report = {
  wasm: wasmPath,
  functions: rows.length,
  named: customNames.size,
  importFuncs: importFuncCount,
  declaredFuncs: declaredFuncCount,
  codeBytes: codeTotal,
  dataBytes: dataSection?.size ?? 0,
  groups: [...groups.entries()].sort((a, b) => b[1] - a[1]),
  top: rows.slice(0, topN),
};

console.log(`wasm: ${wasmPath}`);
console.log(
  `functions: ${report.functions} (named ${report.named}) code=${report.codeBytes} data=${report.dataBytes}`,
);
console.log("\nBy group:");
for (const [g, size] of report.groups) {
  console.log(
    `  ${g.padEnd(14)} ${String(size).padStart(8)}  ${(100 * size) / codeTotal}%`
      .replace(/%/, "")
      .trimEnd() + `%`,
  );
}
console.log(`\nTop ${topN}:`);
for (const row of report.top) {
  console.log(`  ${String(row.size).padStart(7)}  ${row.group.padEnd(12)}  ${row.name}`);
}

const logDir = join(repo, ".cache/logs");
mkdirSync(logDir, { recursive: true });
writeFileSync(join(logDir, "wasm-symbols.json"), JSON.stringify(report, null, 2));
