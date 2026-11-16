import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, "../../..");
const metricsDir = join(
  repoRoot,
  "node_modules/.bun/@cantoo+pdf-lib@2.11.1+e12ec37677079d63/node_modules/@cantoo/pdf-lib/src/packages/standard-fonts/font_metrics",
);
const encodingsJs = readFileSync(join(root, "pdfjs-encodings.js"), "utf8");

const STANDARD14 = [
  "Courier",
  "Courier-Bold",
  "Courier-BoldOblique",
  "Courier-Oblique",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-BoldOblique",
  "Helvetica-Oblique",
  "Symbol",
  "Times-Bold",
  "Times-BoldItalic",
  "Times-Italic",
  "Times-Roman",
  "ZapfDingbats",
] as const;

type EncodingArray = string[];

const exportIndex = encodingsJs.indexOf("\nexport {");
const encodingsBody =
  exportIndex >= 0 ? encodingsJs.slice(0, exportIndex) : encodingsJs;
const encodings = new Function(
  `${encodingsBody}\nreturn { WinAnsiEncoding, StandardEncoding, MacRomanEncoding, MacExpertEncoding, SymbolSetEncoding, ZapfDingbatsEncoding };`,
)() as Record<string, EncodingArray>;

const winAnsi = encodings.WinAnsiEncoding;
const standardEncoding = encodings.StandardEncoding;
const macRoman = encodings.MacRomanEncoding;
const macExpert = encodings.MacExpertEncoding;
const symbolEnc = encodings.SymbolSetEncoding;
const zapfEnc = encodings.ZapfDingbatsEncoding;

const pdfDocUnicode: number[] = Array.from({ length: 256 }, (_, i) => i);
const pdfDocDiffs: Array<[number, number]> = [
  [0x16, 0x0017],
  [0x18, 0x02d8],
  [0x19, 0x02c7],
  [0x1a, 0x02c6],
  [0x1b, 0x02d9],
  [0x1c, 0x02dd],
  [0x1d, 0x02db],
  [0x1e, 0x02da],
  [0x1f, 0x02dc],
  [0x7f, 0xfffd],
  [0x80, 0x2022],
  [0x81, 0x2020],
  [0x82, 0x2021],
  [0x83, 0x2026],
  [0x84, 0x2014],
  [0x85, 0x2013],
  [0x86, 0x0192],
  [0x87, 0x2044],
  [0x88, 0x2039],
  [0x89, 0x203a],
  [0x8a, 0x2212],
  [0x8b, 0x2030],
  [0x8c, 0x201e],
  [0x8d, 0x201c],
  [0x8e, 0x201d],
  [0x8f, 0x2018],
  [0x90, 0x2019],
  [0x91, 0x201a],
  [0x92, 0x2122],
  [0x93, 0xfb01],
  [0x94, 0xfb02],
  [0x95, 0x0141],
  [0x96, 0x0152],
  [0x97, 0x0160],
  [0x98, 0x0178],
  [0x99, 0x017d],
  [0x9a, 0x0131],
  [0x9b, 0x0142],
  [0x9c, 0x0153],
  [0x9d, 0x0161],
  [0x9e, 0x017e],
  [0x9f, 0xfffd],
  [0xa0, 0x20ac],
  [0xad, 0xfffd],
];
for (const [byte, cp] of pdfDocDiffs) {
  pdfDocUnicode[byte] = cp;
}

const glyphList = readFileSync(join(root, "glyphlist.txt"), "utf8");
const aglEntries: Array<{ name: string; codepoints: number[] }> = [];
const unicodeToName = new Map<number, string>();
for (const line of glyphList.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    continue;
  }
  const semi = trimmed.indexOf(";");
  if (semi < 0) {
    continue;
  }
  const name = trimmed.slice(0, semi);
  const codes = trimmed
    .slice(semi + 1)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 16));
  aglEntries.push({ name, codepoints: codes });
  for (const cp of codes) {
    if (!unicodeToName.has(cp)) {
      unicodeToName.set(cp, name);
    }
  }
}
aglEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const pdfDocEncoding: string[] = [];
for (let i = 0; i < 256; i += 1) {
  const cp = pdfDocUnicode[i] ?? i;
  const mapped = unicodeToName.get(cp);
  if (mapped) {
    pdfDocEncoding.push(mapped);
  } else if (cp >= 0x20 && cp <= 0x7e) {
    pdfDocEncoding.push(String.fromCodePoint(cp));
  } else if (i === 0x20) {
    pdfDocEncoding.push("space");
  } else {
    pdfDocEncoding.push("");
  }
}

const allEncodings: Record<string, EncodingArray> = {
  WinAnsi: winAnsi,
  Standard: standardEncoding,
  MacRoman: macRoman,
  MacExpert: macExpert,
  Symbol: symbolEnc,
  ZapfDingbats: zapfEnc,
  PdfDoc: pdfDocEncoding,
};

const nameSet = new Set<string>();
for (const enc of Object.values(allEncodings)) {
  for (const name of enc) {
    if (name) {
      nameSet.add(name);
    }
  }
}
for (const entry of aglEntries) {
  nameSet.add(entry.name);
}
for (const font of STANDARD14) {
  const metrics = JSON.parse(
    readFileSync(join(metricsDir, `${font}.json`), "utf8"),
  ) as { CharMetrics: Array<{ N: string; WX: number }> };
  for (const metric of metrics.CharMetrics) {
    nameSet.add(metric.N);
  }
}

const sortedNames = [...nameSet].sort();
const nameIndex = new Map<string, number>();
const nameBlobParts: string[] = [];
let blob = "";
for (const name of sortedNames) {
  nameIndex.set(name, nameBlobParts.length);
  nameBlobParts.push(name);
  blob += `${name}\0`;
}

function encodingToIndices(enc: EncodingArray): number[] {
  return enc.map((name) => (name ? (nameIndex.get(name) ?? 0xffff) : 0xffff));
}

type WidthMap = Map<string, number>;
const standard14Widths: number[][] = [];
for (const font of STANDARD14) {
  const metrics = JSON.parse(
    readFileSync(join(metricsDir, `${font}.json`), "utf8"),
  ) as { CharMetrics: Array<{ N: string; WX: number }> };
  const byName: WidthMap = new Map();
  for (const metric of metrics.CharMetrics) {
    byName.set(metric.N, metric.WX);
  }
  const row = winAnsi.map((glyph) => byName.get(glyph) ?? 0);
  standard14Widths.push(row);
}

function escapeRustString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function emitByteSlice(data: string, constName: string): string[] {
  const bytes = [...data].map((ch) => ch.charCodeAt(0) & 0xff);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 24) {
    const slice = bytes.slice(i, i + 24).map((b) => `0x${b.toString(16).padStart(2, "0")}`);
    chunks.push(`    ${slice.join(", ")},`);
  }
  return [`pub const ${constName}: &[u8] = &[`, ...chunks, `];`];
}

function emitU16Array(values: number[], perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += perLine) {
    const chunk = values.slice(i, i + perLine).map((v) => v.toString());
    lines.push(`    ${chunk.join(", ")},`);
  }
  return lines.join("\n");
}

const aglNameOffsets: number[] = [];
const aglCodepointStarts: number[] = [];
const aglCodepoints: number[] = [];
let aglNamesBlob = "";
for (const entry of aglEntries) {
  aglNameOffsets.push(aglNamesBlob.length);
  aglCodepointStarts.push(aglCodepoints.length);
  for (const cp of entry.codepoints) {
    aglCodepoints.push(cp);
  }
  aglCodepoints.push(0);
  aglNamesBlob += `${entry.name}\0`;
}

const encodingEnum = [
  "WinAnsi",
  "Standard",
  "MacRoman",
  "MacExpert",
  "Symbol",
  "ZapfDingbats",
  "PdfDoc",
  "Custom",
] as const;

const lines: string[] = [];
lines.push("// @generated by shared/pdf-core/scripts/generate-font-tables.ts");
lines.push("#![allow(non_camel_case_types, clippy::indexing_slicing)]");
lines.push("");
lines.push(...emitByteSlice(blob, "GLYPH_NAME_BLOB"));
lines.push("");
lines.push(...emitByteSlice(aglNamesBlob, "AGL_NAME_BLOB"));
lines.push("");
lines.push("pub const AGL_NAME_OFFSETS: &[u32] = &[");
lines.push(
  aglNameOffsets.map((offset) => `    ${offset},`).join("\n"),
);
lines.push("];");
lines.push("");
lines.push("pub const AGL_CODEPOINT_STARTS: &[u32] = &[");
lines.push(aglCodepointStarts.map((start) => `    ${start},`).join("\n"));
lines.push("];");
lines.push("");
lines.push("pub const AGL_CODEPOINTS: &[u32] = &[");
lines.push(aglCodepoints.map((cp) => `    ${cp},`).join("\n"));
lines.push("];");
lines.push("");
lines.push("#[derive(Clone, Copy, Debug, PartialEq, Eq)]");
lines.push("#[repr(u8)]");
lines.push("pub enum BuiltinEncoding {");
for (let i = 0; i < encodingEnum.length - 1; i += 1) {
  lines.push(`    ${encodingEnum[i]} = ${i},`);
}
lines.push(`    ${encodingEnum[encodingEnum.length - 1]} = ${encodingEnum.length - 1},`);
lines.push("}");
lines.push("");
lines.push("pub const ENCODING_TABLES: &[&[u16; 256]] = &[");
for (const key of [
  "WinAnsi",
  "Standard",
  "MacRoman",
  "MacExpert",
  "Symbol",
  "ZapfDingbats",
  "PdfDoc",
]) {
  const indices = encodingToIndices(allEncodings[key] ?? []);
  lines.push(`    &[`);
  lines.push(emitU16Array(indices));
  lines.push(`    ],`);
}
lines.push("];");
lines.push("");
lines.push("#[derive(Clone, Copy, Debug, PartialEq, Eq)]");
lines.push("#[repr(u8)]");
lines.push("pub enum Standard14Font {");
for (let i = 0; i < STANDARD14.length; i += 1) {
  const id = STANDARD14[i].replace(/-/g, "_");
  lines.push(`    ${id} = ${i},`);
}
lines.push("}");
lines.push("");
lines.push("pub const STANDARD14_WIDTHS: &[&[u16; 256]] = &[");
for (const row of standard14Widths) {
  lines.push("    &[");
  lines.push(emitU16Array(row));
  lines.push("    ],");
}
lines.push("];");
lines.push("");
lines.push(`pub const GLYPH_NAME_INDEX: &[(&str, u16)] = &[`);
for (const name of sortedNames) {
  const index = nameIndex.get(name);
  if (index !== undefined) {
    lines.push(`    ("${escapeRustString(name)}", ${index}),`);
  }
}
lines.push("];");
lines.push("");
lines.push("pub fn glyph_name_at(index: u16) -> &'static str {");
lines.push("    if index as usize >= GLYPH_NAME_INDEX.len() {");
lines.push('        return "";');
lines.push("    }");
lines.push("    GLYPH_NAME_INDEX[index as usize].0");
lines.push("}");
lines.push("");
lines.push("pub fn encoding_glyph_name(encoding: BuiltinEncoding, code: u8) -> &'static str {");
lines.push("    let table = match encoding {");
lines.push("        BuiltinEncoding::WinAnsi => &ENCODING_TABLES[0],");
lines.push("        BuiltinEncoding::Standard => &ENCODING_TABLES[1],");
lines.push("        BuiltinEncoding::MacRoman => &ENCODING_TABLES[2],");
lines.push("        BuiltinEncoding::MacExpert => &ENCODING_TABLES[3],");
lines.push("        BuiltinEncoding::Symbol => &ENCODING_TABLES[4],");
lines.push("        BuiltinEncoding::ZapfDingbats => &ENCODING_TABLES[5],");
lines.push("        BuiltinEncoding::PdfDoc => &ENCODING_TABLES[6],");
lines.push("        BuiltinEncoding::Custom => return \"\",");
lines.push("    };");
lines.push("    let idx = table[code as usize];");
lines.push("    if idx == 0xffff {");
lines.push('        return "";');
lines.push("    }");
lines.push("    glyph_name_at(idx)");
lines.push("}");
lines.push("");
lines.push("pub fn lookup_agl(name: &[u8]) -> Option<&[u32]> {");
lines.push("    let name_str = core::str::from_utf8(name).ok()?;");
lines.push("    let mut lo = 0usize;");
lines.push("    let mut hi = AGL_NAME_OFFSETS.len();");
lines.push("    while lo < hi {");
lines.push("        let mid = lo + (hi - lo) / 2;");
lines.push("        let start = AGL_NAME_OFFSETS[mid] as usize;");
lines.push("        let end = if mid + 1 < AGL_NAME_OFFSETS.len() {");
lines.push("            AGL_NAME_OFFSETS[mid + 1] as usize");
lines.push("        } else {");
lines.push("            AGL_NAME_BLOB.len()");
lines.push("        };");
lines.push("        let entry = core::str::from_utf8(&AGL_NAME_BLOB[start..end]).ok()?;");
lines.push("        let entry = entry.trim_end_matches('\\0');");
lines.push("        if entry == name_str {");
lines.push("            let cp_start = AGL_CODEPOINT_STARTS[mid] as usize;");
lines.push("            let mut cp_end = cp_start;");
lines.push("            while cp_end < AGL_CODEPOINTS.len() && AGL_CODEPOINTS[cp_end] != 0 {");
lines.push("                cp_end += 1;");
lines.push("            }");
lines.push("            return Some(&AGL_CODEPOINTS[cp_start..cp_end]);");
lines.push("        }");
lines.push("        if entry < name_str {");
lines.push("            lo = mid + 1;");
lines.push("        } else {");
lines.push("            hi = mid;");
lines.push("        }");
lines.push("    }");
lines.push("    None");
lines.push("}");

const outPath = join(root, "../rust/src/font_tables.rs");
writeFileSync(outPath, `${lines.join("\n")}\n`);
console.log(`wrote ${outPath} (${lines.length} lines)`);