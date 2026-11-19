/**
 * Build the Portuguese OCR lexicon from native PDF text layers.
 *
 * Usage, from the repo root, after `bun run build` has produced
 * `shared/pdf-core/dist/pdf-core.wasm`:
 *   bun shared/pdf-core/bench/ocr/build-lexicon.ts
 *   bun shared/pdf-core/bench/ocr/build-lexicon.ts --sample
 *
 * Corpus: every `*.pdf` under `/home/yorizel/Documents/bench-parsers` except
 * `editais-extra/digitalizados` and `node_modules`. A document is held out of
 * the lexicon when FNV-1a 32-bit of its path relative to that root, with `/`
 * separators, modulo 5 is 0. Counts are case-folded with diacritics kept
 * (ASCII and Latin-1 upper case + 0x20, NFC). No third-party word list is read.
 *
 * Output (little-endian), at most 400_000 bytes:
 *   magic `LXC1`
 *   u16 version = 1
 *   u16 word_count
 *   u32 bigram_count
 *   u32 stripped_count
 *   words, sorted by UTF-8, front-coded: u8 prefix, u8 suffix_len, suffix, u8 log2 bucket
 *   stripped groups, same front-coding, then u8 id_count and that many u16 word ids
 *   bigrams sorted by (left, right): u16 left, u16 right
 *
 * `--sample` writes a tiny built-in table so the Rust crate compiles before the
 * corpus run. The committed table is the corpus output.
 */
import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const dataDir = join(pkg, "rust/ocr/data");
const corpusRoot = "/home/yorizel/Documents/bench-parsers";
const byteBudget = 400_000;
const maxWordBytes = 64;
const maxWordChars = 40;
const maxWords = 65_535;
const maxIdsPerStrip = 8;

type Counts = Map<string, number>;

type PageText = (pdf: Uint8Array) => Promise<readonly string[]>;

const sampleWords: readonly (readonly [string, number])[] = [
  ["a", 800],
  ["ação", 200],
  ["adjudicação", 80],
  ["administração", 180],
  ["anexo", 90],
  ["artigo", 140],
  ["as", 400],
  ["assinatura", 70],
  ["até", 60],
  ["certidão", 75],
  ["com", 500],
  ["comissão", 110],
  ["conforme", 95],
  ["contrato", 220],
  ["contratação", 130],
  ["critério", 85],
  ["da", 700],
  ["das", 240],
  ["de", 900],
  ["declaração", 100],
  ["decreto", 65],
  ["diário", 55],
  ["dispensa", 50],
  ["do", 680],
  ["documento", 120],
  ["dos", 260],
  ["e", 750],
  ["econômica", 70],
  ["edital", 300],
  ["em", 420],
  ["empresa", 160],
  ["entre", 45],
  ["esclarecimento", 40],
  ["estado", 90],
  ["federal", 100],
  ["financeira", 80],
  ["fiscal", 110],
  ["governo", 75],
  ["habilitação", 150],
  ["homologação", 60],
  ["impugnação", 40],
  ["inciso", 85],
  ["inexigibilidade", 30],
  ["instrução", 35],
  ["item", 200],
  ["julgamento", 90],
  ["lance", 55],
  ["lei", 120],
  ["licitação", 260],
  ["mais", 40],
  ["modalidade", 70],
  ["município", 140],
  ["na", 180],
  ["nacional", 80],
  ["nas", 70],
  ["no", 190],
  ["normativa", 30],
  ["nos", 60],
  ["não", 210],
  ["número", 100],
  ["o", 820],
  ["objeto", 130],
  ["oficial", 90],
  ["os", 360],
  ["ou", 150],
  ["para", 280],
  ["parágrafo", 75],
  ["por", 170],
  ["portaria", 45],
  ["prazo", 110],
  ["prefeitura", 100],
  ["pregão", 190],
  ["preço", 120],
  ["processo", 160],
  ["proposta", 140],
  ["publicação", 80],
  ["pública", 170],
  ["qualificação", 90],
  ["que", 240],
  ["recurso", 70],
  ["regularidade", 65],
  ["resolução", 40],
  ["responsável", 55],
  ["secretaria", 85],
  ["sem", 50],
  ["serviço", 150],
  ["sessão", 100],
  ["se", 90],
  ["sob", 30],
  ["sobre", 45],
  ["técnica", 100],
  ["uma", 80],
  ["união", 70],
  ["valor", 130],
];

const sampleLines = [
  "A licitação pública segue o edital e o contrato do município",
  "A administração julga a habilitação e a proposta da empresa",
  "O pregão eletrônico observa o critério e o prazo do edital",
  "A comissão confere a certidão de regularidade fiscal e a declaração",
  "O objeto da contratação consta do anexo e do documento oficial",
  "A sessão pública registra o lance e o preço do serviço",
  "A homologação e a adjudicação seguem o julgamento do processo",
  "A prefeitura publica o edital no diário oficial da união",
  "A qualificação técnica e a qualificação econômica integram a habilitação",
  "O artigo e o parágrafo do decreto disciplinam a dispensa",
  "A secretaria analisa o recurso e a impugnação da empresa",
  "O responsável assina a declaração conforme o edital e a lei",
  "A modalidade e o critério constam do processo de licitação",
  "O município observa a instrução normativa e a resolução federal",
  "A comissão de licitação examina a proposta e o documento",
  "O valor e o prazo do serviço constam do contrato e do anexo",
  "A publicação no diário oficial dá ciência do edital à empresa",
  "A regularidade fiscal e a certidão integram a habilitação",
  "O governo federal disciplina a contratação por pregão",
  "A sessão de julgamento apura o lance de menor preço",
  "O objeto e o item do anexo descrevem o serviço contratado",
  "A administração municipal conduz o processo de licitação pública",
  "A proposta da empresa atende ao edital e ao prazo",
  "O contrato administrativo decorre da adjudicação e da homologação",
];

function foldToken(token: string): string {
  let folded = "";
  for (const ch of token.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x41 && code <= 0x5a) {
      folded += String.fromCodePoint(code + 0x20);
      continue;
    }
    if ((code >= 0x00c0 && code <= 0x00d6) || (code >= 0x00d8 && code <= 0x00de)) {
      folded += String.fromCodePoint(code + 0x20);
      continue;
    }
    folded += ch;
  }
  return folded;
}

function stripChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (
    code === 0x00e0 ||
    code === 0x00e1 ||
    code === 0x00e2 ||
    code === 0x00e3 ||
    code === 0x00e4 ||
    code === 0x00e5
  ) {
    return "a";
  }
  if (code === 0x00e7) {
    return "c";
  }
  if (code === 0x00e8 || code === 0x00e9 || code === 0x00ea || code === 0x00eb) {
    return "e";
  }
  if (code === 0x00ec || code === 0x00ed || code === 0x00ee || code === 0x00ef) {
    return "i";
  }
  if (code === 0x00f1) {
    return "n";
  }
  if (code === 0x00f2 || code === 0x00f3 || code === 0x00f4 || code === 0x00f5 || code === 0x00f6) {
    return "o";
  }
  if (code === 0x00f9 || code === 0x00fa || code === 0x00fb || code === 0x00fc) {
    return "u";
  }
  if (code === 0x00fd || code === 0x00ff) {
    return "y";
  }
  return ch;
}

function stripWord(word: string): string {
  let stripped = "";
  for (const ch of word) {
    stripped += stripChar(ch);
  }
  return stripped;
}

function bucketOf(count: number): number {
  let level = 0;
  let value = count;
  while (value > 1 && level < 15) {
    value = Math.floor(value / 2);
    level += 1;
  }
  return level;
}

function fnv1a(text: string): number {
  let hash = 0x811c_9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash >>> 0;
}

function heldOut(relativePath: string): boolean {
  return fnv1a(relativePath) % 5 === 0;
}

function addCount(counts: Counts, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function repeatedRun(word: string): boolean {
  let run = 1;
  let previous = "";
  for (const ch of word) {
    if (ch === previous) {
      run += 1;
      if (run >= 5) {
        return true;
      }
    } else {
      run = 1;
      previous = ch;
    }
  }
  return false;
}

function keepToken(word: string): boolean {
  if (word.length > maxWordChars || new TextEncoder().encode(word).length > maxWordBytes) {
    return false;
  }
  if (repeatedRun(word)) {
    return false;
  }
  if (word.length >= 2) {
    return true;
  }
  return word === "a" || word === "e" || word === "o" || word === "à" || word === "á";
}

function consumeText(text: string, words: Counts, bigrams: Counts): void {
  let previous: string | undefined;
  let previousEnd = 0;
  for (const match of text.matchAll(/\p{L}+/gu)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (token === undefined) {
      continue;
    }
    const gap = text.slice(previousEnd, start);
    const folded = foldToken(token);
    previousEnd = start + token.length;
    if (!keepToken(folded)) {
      previous = undefined;
      continue;
    }
    addCount(words, folded);
    const boundary = /[.!?;\n]/.test(gap);
    if (previous !== undefined && !boundary) {
      addCount(bigrams, `${previous}\t${folded}`);
    }
    previous = folded;
  }
}

function commonPrefix(prev: Uint8Array, next: Uint8Array): number {
  const limit = Math.min(prev.length, next.length, 255);
  let index = 0;
  while (index < limit && prev[index] === next[index]) {
    index += 1;
  }
  while (index > 0 && ((next[index] ?? 0) & 0xc0) === 0x80) {
    index -= 1;
  }
  return index;
}

function pushFront(out: number[], previous: Uint8Array | undefined, bytes: Uint8Array): void {
  const prefix = previous === undefined ? 0 : commonPrefix(previous, bytes);
  const suffixLength = bytes.length - prefix;
  if (suffixLength > 255) {
    out.push(0, bytes.length);
    for (const byte of bytes) {
      out.push(byte);
    }
    return;
  }
  out.push(prefix, suffixLength);
  for (let index = prefix; index < bytes.length; index += 1) {
    out.push(bytes[index] ?? 0);
  }
}

type Encoded = {
  bigramCap: number;
  bigramMin: number;
  bigrams: number;
  bytes: Uint8Array;
  minCount: number;
  stripped: number;
  words: number;
};

function encode(
  wordCounts: Counts,
  bigramCounts: Counts,
  minCount: number,
  bigramMin: number,
  bigramCap: number,
): Encoded {
  const selected = [...wordCounts.entries()]
    .filter((entry) => entry[1] >= minCount && keepToken(entry[0]))
    .sort(
      (left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
    )
    .slice(0, maxWords)
    .map(([word, count]) => ({ bucket: bucketOf(count), count, word }))
    .sort((left, right) => (left.word < right.word ? -1 : left.word > right.word ? 1 : 0));
  const ids = new Map<string, number>();
  selected.forEach((entry, index) => {
    ids.set(entry.word, index);
  });

  const out: number[] = [0x4c, 0x58, 0x43, 0x31, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let previous: Uint8Array | undefined;
  for (const entry of selected) {
    const bytes = new TextEncoder().encode(entry.word);
    pushFront(out, previous, bytes);
    out.push(entry.bucket);
    previous = bytes;
  }

  const groups = new Map<string, number[]>();
  for (const entry of selected) {
    const stripped = stripWord(entry.word);
    const id = ids.get(entry.word);
    if (id === undefined) {
      continue;
    }
    const list = groups.get(stripped);
    if (list === undefined) {
      groups.set(stripped, [id]);
    } else {
      list.push(id);
    }
  }
  const groupEntries = [...groups.entries()]
    .filter((entry) => {
      const [stripped, list] = entry;
      return list.length > 1 || list.some((id) => selected[id]?.word !== stripped);
    })
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  previous = undefined;
  for (const [stripped, list] of groupEntries) {
    const bytes = new TextEncoder().encode(stripped);
    const ranked = [...list].sort((left, right) => {
      const leftBucket = selected[left]?.bucket ?? 0;
      const rightBucket = selected[right]?.bucket ?? 0;
      return rightBucket - leftBucket || left - right;
    });
    const kept = ranked.slice(0, maxIdsPerStrip);
    pushFront(out, previous, bytes);
    out.push(kept.length);
    for (const id of kept) {
      out.push(id & 0xff, (id >> 8) & 0xff);
    }
    previous = bytes;
  }

  const pairs = [...bigramCounts.entries()]
    .map((entry) => {
      const [key, count] = entry;
      const [left, right] = key.split("\t");
      if (left === undefined || right === undefined || count < bigramMin) {
        return undefined;
      }
      const leftId = ids.get(left);
      const rightId = ids.get(right);
      if (leftId === undefined || rightId === undefined) {
        return undefined;
      }
      return { count, leftId, rightId };
    })
    .filter(
      (pair): pair is { count: number; leftId: number; rightId: number } => pair !== undefined,
    )
    .sort(
      (left, right) =>
        right.count - left.count || left.leftId - right.leftId || left.rightId - right.rightId,
    )
    .slice(0, bigramCap)
    .sort((left, right) => left.leftId - right.leftId || left.rightId - right.rightId);
  for (const pair of pairs) {
    out.push(
      pair.leftId & 0xff,
      (pair.leftId >> 8) & 0xff,
      pair.rightId & 0xff,
      (pair.rightId >> 8) & 0xff,
    );
  }

  out[6] = selected.length & 0xff;
  out[7] = (selected.length >> 8) & 0xff;
  out[8] = pairs.length & 0xff;
  out[9] = (pairs.length >> 8) & 0xff;
  out[10] = (pairs.length >> 16) & 0xff;
  out[11] = (pairs.length >> 24) & 0xff;
  out[12] = groupEntries.length & 0xff;
  out[13] = (groupEntries.length >> 8) & 0xff;
  out[14] = (groupEntries.length >> 16) & 0xff;
  out[15] = (groupEntries.length >> 24) & 0xff;
  return {
    bigramCap,
    bigramMin,
    bigrams: pairs.length,
    bytes: Uint8Array.from(out),
    minCount,
    stripped: groupEntries.length,
    words: selected.length,
  };
}

function fit(wordCounts: Counts, bigramCounts: Counts): Encoded {
  let minCount = 2;
  let bigramCap = 16_000;
  const bigramMin = 4;
  let encoded = encode(wordCounts, bigramCounts, minCount, bigramMin, bigramCap);
  while (encoded.bytes.length > byteBudget) {
    if (minCount < 8) {
      minCount += 1;
    } else if (bigramCap > 4_000) {
      bigramCap -= 2_000;
    } else if (minCount < 32) {
      minCount += 1;
    } else if (bigramCap > 0) {
      bigramCap = Math.max(0, bigramCap - 2_000);
    } else if (minCount < 4_096) {
      minCount *= 2;
    } else {
      throw new Error(`lexicon does not fit in ${byteBudget} bytes at minCount=${minCount}`);
    }
    encoded = encode(wordCounts, bigramCounts, minCount, bigramMin, bigramCap);
  }
  return encoded;
}

function walkPdfs(dir: string, found: string[]): void {
  const names: readonly string[] = readdirSync(dir).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const name of names) {
    const skippedName = name === "node_modules" || name.startsWith(".");
    if (skippedName) {
      continue;
    }
    const path = join(dir, name);
    const relativePath: string = relative(corpusRoot, path).split("\\").join("/");
    const skippedDir: boolean =
      relativePath === "editais-extra/digitalizados" ||
      relativePath.startsWith("editais-extra/digitalizados/");
    if (skippedDir) {
      continue;
    }
    const info = statSync(path);
    if (info.isDirectory() === true) {
      walkPdfs(path, found);
      continue;
    }
    if (info.isFile() === true && name.endsWith(".pdf") === true) {
      found.push(path);
    }
  }
}

function qualifyingLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/\s+/g, " ");
    const words = trimmed.match(/\p{L}+/gu);
    if (words !== null && words.length >= 8 && trimmed.length >= 40 && trimmed.length <= 240) {
      lines.push(trimmed);
    }
    if (lines.length >= 2) {
      break;
    }
  }
  return lines;
}

function protectedTokens(text: string): string[] {
  const patterns = [
    /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g,
    /\d{3}\.\d{3}\.\d{3}-\d{2}/g,
    /\d{5}-\d{3}/g,
    /\d{1,2}\/\d{1,2}\/\d{2,4}/g,
    /\d{4}-\d{2}-\d{2}/g,
    /R\$\s?\d{1,3}(?:\.\d{3})*,\d{2}/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0];
      if (token !== undefined) {
        found.push(token);
      }
    }
  }
  return found;
}

async function loadReaders(concurrency: number): Promise<PageText[]> {
  const wasm = await readFile(join(pkg, "dist/pdf-core.wasm"));
  const module = await WebAssembly.compile(wasm);
  const promiseUrl = pathToFileURL(join(pkg, "src/promise.ts")).href;
  const imported = await import(promiseUrl);
  const create = imported.createPdfCoreClient;
  if (typeof create !== "function") {
    throw new Error("pdf-core promise client is missing createPdfCoreClient");
  }
  const readers: PageText[] = [];
  for (let index = 0; index < concurrency; index += 1) {
    const client = await create(module);
    readers.push(async (pdf) => client.text(pdf, { dropRunningHeaders: true }));
  }
  return readers;
}

async function extractCorpus(): Promise<{
  bigrams: Counts;
  failures: number;
  heldoutDocs: number;
  lines: string[];
  protectedSamples: string[];
  trainDocs: number;
  words: Counts;
}> {
  const paths: string[] = [];
  walkPdfs(corpusRoot, paths);
  paths.sort();
  const readers = await loadReaders(4);
  const parts: Array<{
    bigrams: Counts;
    failures: number;
    heldoutDocs: number;
    lines: string[];
    protectedSamples: string[];
    trainDocs: number;
    words: Counts;
  }> = readers.map(() => ({
    bigrams: new Map(),
    failures: 0,
    heldoutDocs: 0,
    lines: [],
    protectedSamples: [],
    trainDocs: 0,
    words: new Map(),
  }));
  let cursor = 0;
  let finished = 0;
  async function worker(slot: number): Promise<void> {
    const reader = readers[slot];
    const part = parts[slot];
    if (reader === undefined || part === undefined) {
      return;
    }
    for (;;) {
      const index = cursor;
      cursor += 1;
      const path = paths[index];
      if (path === undefined) {
        return;
      }
      const relativePath = relative(corpusRoot, path).split("\\").join("/");
      const training = !heldOut(relativePath);
      try {
        const bytes = new Uint8Array(await readFile(path));
        if (bytes.byteLength > 40_000_000) {
          part.failures += 1;
          continue;
        }
        const pages = await reader(bytes);
        const text = pages.join("\n");
        if (training) {
          consumeText(text, part.words, part.bigrams);
          part.trainDocs += 1;
        } else {
          part.heldoutDocs += 1;
          part.lines.push(...qualifyingLines(text));
          part.protectedSamples.push(...protectedTokens(text));
        }
      } catch {
        part.failures += 1;
      }
      finished += 1;
      if (finished % 100 === 0) {
        process.stderr.write(`lexicon ${finished}/${paths.length}\n`);
      }
    }
  }
  await Promise.all(parts.map((_part, slot) => worker(slot)));
  const words: Counts = new Map();
  const bigrams: Counts = new Map();
  const lines: string[] = [];
  const protectedSamples: string[] = [];
  let failures = 0;
  let heldoutDocs = 0;
  let trainDocs = 0;
  for (const part of parts) {
    for (const [key, count] of part.words) {
      words.set(key, (words.get(key) ?? 0) + count);
    }
    for (const [key, count] of part.bigrams) {
      bigrams.set(key, (bigrams.get(key) ?? 0) + count);
    }
    lines.push(...part.lines);
    protectedSamples.push(...part.protectedSamples);
    failures += part.failures;
    heldoutDocs += part.heldoutDocs;
    trainDocs += part.trainDocs;
  }
  lines.sort();
  return {
    bigrams,
    failures,
    heldoutDocs,
    lines: [...new Set(lines)].slice(0, 400),
    protectedSamples: [...new Set(protectedSamples)].sort().slice(0, 80),
    trainDocs,
    words,
  };
}

function sampleCorpus(): {
  bigrams: Counts;
  lines: string[];
  words: Counts;
} {
  const words: Counts = new Map(sampleWords);
  const bigrams: Counts = new Map();
  for (const line of sampleLines) {
    consumeText(line, new Map(), bigrams);
  }
  for (const [key, count] of bigrams) {
    bigrams.set(key, count * 20);
  }
  return { bigrams, lines: [...sampleLines], words };
}

async function main(): Promise<void> {
  const args: readonly string[] = process.argv;
  const sample = args.includes("--sample") === true;
  const collected =
    sample === true
      ? {
          ...sampleCorpus(),
          failures: 0,
          heldoutDocs: 0,
          protectedSamples: [
            "12.345.678/0001-95",
            "123.456.789-09",
            "01310-100",
            "31/12/2024",
            "R$1.234,56",
          ],
          trainDocs: 0,
        }
      : await extractCorpus();
  const encoded = fit(collected.words, collected.bigrams);
  if (encoded.bytes.length > byteBudget) {
    throw new Error(`lexicon is ${encoded.bytes.length} bytes, budget is ${byteBudget}`);
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "lexicon.bin"), encoded.bytes);
  await writeFile(join(dataDir, "lexicon-heldout.txt"), `${collected.lines.join("\n")}\n`);
  await writeFile(
    join(dataDir, "lexicon-protected.txt"),
    `${collected.protectedSamples.join("\n")}\n`,
  );
  const stats = [
    `bytes=${encoded.bytes.length}`,
    `words=${encoded.words}`,
    `bigrams=${encoded.bigrams}`,
    `stripped=${encoded.stripped}`,
    `min_count=${encoded.minCount}`,
    `bigram_min=${encoded.bigramMin}`,
    `bigram_cap=${encoded.bigramCap}`,
    `train_docs=${collected.trainDocs}`,
    `heldout_docs=${collected.heldoutDocs}`,
    `failures=${collected.failures}`,
    `heldout_lines=${collected.lines.length}`,
    `raw_types=${collected.words.size}`,
    `sample=${sample}`,
  ].join("\n");
  await writeFile(join(dataDir, "lexicon-stats.txt"), `${stats}\n`);
  process.stderr.write(`${stats}\n`);
}

await main();
