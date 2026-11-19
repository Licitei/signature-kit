import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

const alphabet = [
  ...Array.from({ length: 94 }, (_, index) => index + 33),
  0x80,
  0x91,
  0x92,
  0x93,
  0x94,
  0x96,
  0x97,
  0xa7,
  0xaa,
  0xab,
  0xb0,
  0xba,
  0xbb,
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc7,
  0xc9,
  0xca,
  0xcd,
  0xd3,
  0xd4,
  0xd5,
  0xda,
  0xdc,
  0xe0,
  0xe1,
  0xe2,
  0xe3,
  0xe7,
  0xe9,
  0xea,
  0xed,
  0xf3,
  0xf4,
  0xf5,
  0xfa,
  0xfc,
];
const ansi = new TextDecoder("windows-1252");
const labels = alphabet.map((code) => ansi.decode(Uint8Array.of(code)));
const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text);
const trainingText = [
  "EDITAL DE LICITAÇÃO — PREGÃO ELETRÔNICO Nº 042/2025",
  "Aquisição de materiais e contratação de serviços de manutenção.",
  "A administração pública observará o disposto na legislação aplicável.",
  "O município deverá publicar os avisos no Diário Oficial.",
  "A proposta terá validade de sessenta dias, contados da abertura.",
  "Empresas de pequeno porte poderão apresentar a documentação exigida.",
  "Os preços incluem transporte, mão de obra e demais encargos.",
  "Endereço: Praça da República, 125; CEP 01100-000.",
  "A sessão será realizada às 09h30, no horário de Brasília.",
  "À Comissão de Contratação compete a análise dos recursos.",
  "O técnico responsável deverá emitir relatório de execução.",
  "CONDIÇÕES DE PAGAMENTO E PRAZO DE ENTREGA",
  "1ª etapa: instalação e aferição da tensão nominal de 220 V.",
  "Total estimado R$ 32.183,96; caução de 5% (§ 2º).",
  "CNPJ: 12.345.678/0001-90 — CPF: 123.456.789-09",
  "As informações sobre participação e sanções estão no anexo.",
  "Os órgãos de fiscalização terão acesso à documentação.",
  "Em caso de dúvida, solicite esclarecimentos à unidade de compras.",
];
const evaluationText = [
  "ANEXO IV — ESPECIFICAÇÕES DO OBJETO",
  "É vedada a subcontratação sem autorização expressa.",
  "O índice de correção será apurado após 12 meses.",
  "Apresentação de certidões, vínculos e experiência técnica.",
  "Fiscalização do fornecimento conforme a cláusula décima.",
  "Protocolo nº 0186/2026; entrega até 17/03/2026.",
  "O órgão julgador publicará decisão e a íntegra da ata.",
  "Variação de –4 °C a 48 °C; garantia de 18 meses.",
  "Valor máximo: R$ 89.504,27 (oitenta e nove mil reais).",
  "CRITÉRIOS DE CLASSIFICAÇÃO E JULGAMENTO",
  "Recebimento provisório na 2ª quinzena do mês de junho.",
  "Item 03: água, açúcar, café e suco de maçã.",
  "CNPJ 08.165.277/0001-02 | CPF 014.385.567-32",
  "Revisão das medições (§ 3º) e cálculo do reajuste anual.",
  "Aceitam-se equivalências quando comprovada a eficácia.",
  "NÃO SERÁ ADMITIDA A TROCA DE EQUIPAMENTOS",
];

const testText = [
  "AVISO DE CONTRATAÇÃO DIRETA — DISPENSA Nº 135/2026",
  "O fornecimento deverá ocorrer em até dez dias úteis.",
  "As medições serão acompanhadas pelo fiscal do contrato.",
  "A comissão registrará em ata as manifestações recebidas.",
  "Não haverá restituição de despesas de deslocamento.",
  "A embalagem deverá trazer a indicação de origem.",
  "Prazo para impugnação: 08/09/2026, às 14h25.",
  "A instalação elétrica admite tensão de 127 V e corrente de 15 A.",
  "Preço unitário R$ 1.978,65; desconto de 7,15%.",
  "PROCEDIMENTOS PARA RECEBIMENTO E CONFERÊNCIA",
  "Enviar os arquivos à 3ª unidade gestora do município.",
  "Anexar cópia autenticada do registro e laudo técnico.",
  "CNPJ 26.304.175/0001-39 | CPF 048.692.715-08",
  "Recurso administrativo previsto no art. 167, § 4º.",
  "A sessão de amanhã poderá ser adiada por motivo de força maior.",
  "É OBRIGATÓRIA A EMISSÃO DE NOTA FISCAL ELETRÔNICA",
];

function stream(dictionary, data) {
  return new Blob([
    bytes(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
    data,
    bytes("\nendstream"),
  ]);
}

async function fontSheet(font, openType) {
  const content = alphabet
    .map(
      (code, index) =>
        `1 0 0 1 ${20 + (index % 12) * 100} ${1000 - Math.floor(index / 12) * 88} Tm <${code.toString(16)}> Tj`,
    )
    .join("\n");
  const key = openType ? "FontFile3" : "FontFile2";
  const subtype = openType ? "Type1" : "TrueType";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1230 1090] /Resources << /Font << /F 4 0 R >> >> /Contents 7 0 R >>",
    `<< /Type /Font /Subtype /${subtype} /BaseFont /Synthetic /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${"600 ".repeat(224)}] /FontDescriptor 5 0 R >>`,
    `<< /Type /FontDescriptor /FontName /Synthetic /Flags 32 /FontBBox [-250 -500 1300 1300] /ItalicAngle 0 /Ascent 900 /Descent -270 /CapHeight 700 /StemV 80 /${key} 6 0 R >>`,
    stream(openType ? "/Subtype /OpenType" : `/Length1 ${font.length}`, font),
    stream("", bytes(`BT /F 60 Tf\n${content}\nET`)),
  ];
  const parts = [bytes("%PDF-1.7\n")];
  const xref = ["0000000000 65535 f \n"];
  let offset = parts[0].length;
  for (const [index, object] of objects.entries()) {
    xref.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
    const prefix = bytes(`${index + 1} 0 obj\n`);
    const payload = typeof object === "string" ? bytes(object) : await object.bytes();
    const suffix = bytes("\nendobj\n");
    parts.push(prefix, payload, suffix);
    offset += prefix.length + payload.length + suffix.length;
  }
  parts.push(
    bytes(
      `xref\n0 ${xref.length}\n${xref.join("")}trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return new Blob(parts).bytes();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runPdf(wasm, pdf, operation) {
  const {
    exports: { memory, pdf_core_alloc, pdf_core_free },
  } = wasm;
  const input = pdf_core_alloc(pdf.length);
  if (input === 0) fail("pdf-core input allocation failed");
  new Uint8Array(memory.buffer, input, pdf.length).set(pdf);
  const result = operation(input);
  pdf_core_free(input, pdf.length);
  if (result === 0) fail("pdf-core result allocation failed");
  const view = new DataView(memory.buffer, result);
  const length = view.getUint32(0, true);
  const status = view.getUint32(4, true);
  const payload = new Uint8Array(memory.buffer, result + 8, length - 8).slice();
  pdf_core_free(result, length);
  return { status, payload };
}

function render(wasm, pdf) {
  const { status, payload } = runPdf(wasm, pdf, (input) =>
    wasm.exports.pdf_core_render(input, pdf.length, 0, 0, 0, 1),
  );
  const view = new DataView(payload.buffer);
  if (status !== 0 || view.getUint32(0, true) !== 0x4c524450) {
    fail(`pdf-core glyph rendering failed: ${ansi.decode(payload)}`);
  }
  const start = 16 + 56;
  return payload.subarray(start, start + view.getUint32(16 + 8, true));
}

function firstPageText(wasm, pdf) {
  const { memory, pdf_core_alloc, pdf_core_free, pdf_core_text } = wasm.exports;
  const index = pdf_core_alloc(4);
  if (index === 0) fail("pdf-core page index allocation failed");
  new DataView(memory.buffer).setUint32(index, 0, true);
  const { status, payload } = runPdf(wasm, pdf, (input) =>
    pdf_core_text(input, pdf.length, 4, index, 1),
  );
  pdf_core_free(index, 4);
  if (status !== 0) return "";
  const view = new DataView(payload.buffer);
  if (view.getUint32(0, true) !== 0x58544450 || view.getUint32(8, true) !== 1) return "";
  return new TextDecoder()
    .decode(payload.subarray(24, 24 + view.getUint32(12, true)))
    .normalize("NFC");
}

function polygonEdges(path) {
  const edges = [];
  let start = [0, 0];
  let from = start;
  let position = 0;
  const point = () => {
    const xy = path.coords.slice(position, position + 2);
    position += 2;
    return xy;
  };
  const edge = (target) => {
    if (from[1] !== target[1]) edges.push([...from, ...target]);
    from = target;
  };
  for (const verb of path.verbs) {
    if (verb === 0) {
      from = point();
      start = from;
    } else if (verb === 1) {
      edge(point());
    } else if (verb === 3) {
      edge(start);
    } else {
      const origin = from;
      const first = point();
      const second = verb === 2 ? point() : first;
      const target = point();
      for (let step = 1; step <= 12; step += 1) {
        const t = step / 12;
        const u = 1 - t;
        edge(
          origin.map((value, axis) =>
            verb === 2
              ? u ** 3 * value +
                3 * u ** 2 * t * first[axis] +
                3 * u * t ** 2 * second[axis] +
                t ** 3 * target[axis]
              : u ** 2 * value + 2 * u * t * first[axis] + t ** 2 * target[axis],
          ),
        );
      }
    }
  }
  return edges;
}

function glyphs(ops) {
  const data = new DataView(ops.buffer, ops.byteOffset, ops.byteLength);
  const outlines = new Map();
  const glyphs = new Map();
  let cursor = 0;
  const u8 = () => data.getUint8(cursor++);
  const u32 = () => {
    const value = data.getUint32(cursor, true);
    cursor += 4;
    return value;
  };
  const f32 = () => {
    const value = data.getFloat32(cursor, true);
    cursor += 4;
    return value;
  };
  while (cursor < ops.length) {
    const op = u8();
    if (op === 16) {
      const index = u32();
      const count = u32();
      const verbs = ops.subarray(cursor, cursor + count);
      cursor += count;
      outlines.set(index, polygonEdges({ verbs, coords: Array.from({ length: u32() }, f32) }));
    } else if (op === 17) {
      const mode = u8();
      const index = u32();
      const [a, b, c, d, e, f] = Array.from({ length: 6 }, f32);
      const cell = Math.round((1000 - f) / 88) * 12 + Math.round((e - 20) / 100);
      const label = labels[cell];
      const edges = outlines.get(index);
      if (mode !== 1 || label === undefined || !edges?.length || glyphs.has(label)) {
        fail(`Invalid glyph draw in cell ${cell}`);
      }
      glyphs.set(
        label,
        edges.map(([x0, y0, x1, y1]) => [
          (a * x0 + c * y0) / 60,
          (b * x0 + d * y0) / 60,
          (a * x1 + c * y1) / 60,
          (b * x1 + d * y1) / 60,
        ]),
      );
    } else if (op === 3) {
      cursor += 24;
    } else if (op === 15) {
      cursor += 1;
    } else if (op === 8) {
      cursor += 4;
    } else if (op !== 1 && op !== 2) {
      fail(`Unexpected display-list opcode ${op}`);
    }
  }
  return glyphs;
}

function scanGlyph(edges, size, phase, baseline, shear) {
  const scaled = edges.map(([x0, y0, x1, y1]) => [
    phase + (x0 + y0 * shear) * size,
    baseline - y0 * size,
    phase + (x1 + y1 * shear) * size,
    baseline - y1 * size,
  ]);
  const flatX = scaled.flatMap(([x0, , x1]) => [x0, x1]);
  const left = Math.floor(Math.min(...flatX)) - 1;
  const width = Math.ceil(Math.max(...flatX)) - left + 1;
  const height = Math.ceil(baseline + size * 0.38);
  const coverage = new Uint8Array(width * height);
  for (let yy = 0; yy < height; yy += 1) {
    for (let sample = 0; sample < 4; sample += 1) {
      const y = yy + (sample + 0.5) / 4;
      const crossings = [];
      for (const [x0, y0, x1, y1] of scaled) {
        if (y >= Math.min(y0, y1) && y < Math.max(y0, y1)) {
          crossings.push([x0 + ((y - y0) * (x1 - x0)) / (y1 - y0), Math.sign(y1 - y0)]);
        }
      }
      crossings.sort(([x0], [x1]) => x0 - x1);
      let winding = 0;
      let previous = 0;
      for (const [x, sign] of crossings) {
        if (winding !== 0) {
          const start = Math.ceil((previous - left) * 4 - 0.5);
          const end = Math.ceil((x - left) * 4 - 0.5);
          for (let sx = start; sx < end; sx += 1) coverage[yy * width + (sx >> 2)] += 1;
        }
        winding += sign;
        previous = x;
      }
    }
  }
  return { width, height, coverage };
}

function compose(glyphMap, text, size, degradation, variant) {
  const baseline = size + 3 + variant * 0.13;
  const shear = degradation ? 0.03 : 0;
  const xExtent = glyphMap.get("x").flatMap(([, y0, , y1]) => [y0, y1]);
  const xHeight = (Math.max(...xExtent) - Math.min(...xExtent)) * size;
  const words = [];
  const glyphs = [];
  const bitmaps = [];
  let cursor = 4;
  const targetThreshold = degradation ? (variant % 2 ? 11 : 4) : 7;
  for (const textWord of text.split(/\s+/u)) {
    const start = cursor;
    for (const char of textWord) {
      const edges = glyphMap.get(char);
      if (edges === undefined) fail(`Missing glyph ${char}`);
      const phase = (variant * 0.27 + glyphs.length * 0.37) % 1;
      const { width, height, coverage } = scanGlyph(edges, size, phase, baseline, shear);
      const image = new Uint8Array(width * height);
      const threshold = Math.min(
        targetThreshold,
        coverage.reduce((max, value) => Math.max(max, value), 0),
      );
      for (let idx = 0; idx < coverage.length; idx += 1) {
        const x = idx % width;
        const y = Math.floor(idx / width);
        const hit = coverage[idx] >= threshold;
        const drop = degradation && (idx * 13 + glyphs.length * 3 + variant) % 127 === 0;
        const speckle =
          degradation && x !== 0 && y !== 0 && coverage[idx] > 0 && (idx * 7 + variant) % 71 === 0;
        if ((hit && !drop) || speckle) image[idx] = 1;
      }
      const columnInk = Array.from({ length: width }, (_, x) => {
        for (let y = 0; y < height; y += 1) if (image[y * width + x]) return true;
        return false;
      });
      const first = columnInk.indexOf(true);
      const last = columnInk.lastIndexOf(true) + 1;
      if (first < 0) fail(`Empty glyph ${char}`);
      const glyphWidth = last - first;
      const box = [cursor, 0, cursor + glyphWidth, height];
      glyphs.push({ text: char, box });
      bitmaps.push({ image, width, height, first, last, left: cursor });
      const gap = degradation
        ? glyphs.length % 7 === 0
          ? 0
          : Math.round(size * (0.028 + (glyphs.length % 4) * 0.019))
        : Math.max(1, Math.round(size * 0.065));
      cursor += glyphWidth + gap;
    }
    words.push({ text: textWord, box: [start, 0, glyphs.at(-1).box[2], glyphs.at(-1).box[3]] });
    cursor += Math.round(size * 0.22);
  }
  const width = cursor + 4;
  const height = bitmaps[0].height;
  const pixels = new Uint8Array(width * height);
  for (const bitmap of bitmaps) {
    for (let row = 0; row < height; row += 1) {
      const offset = row * bitmap.width;
      pixels.set(
        bitmap.image.subarray(offset + bitmap.first, offset + bitmap.last),
        row * width + bitmap.left,
      );
    }
  }
  return { width, height, pixels, baseline, xHeight, words, glyphs };
}

function u32(value) {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return data;
}

function f32(value) {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setFloat32(0, value, true);
  return data;
}

function fields(text) {
  const utf8 = bytes(text);
  return [u32(utf8.length), utf8];
}

function archive(lines) {
  return new Blob([
    bytes("OCRT"),
    u32(lines.length),
    ...lines.flatMap((line) => [
      u32(line.width),
      u32(line.height),
      f32(line.baseline),
      f32(line.xHeight),
      u32(line.words.length),
      u32(line.glyphs.length),
      line.pixels,
      ...[...line.words, ...line.glyphs].flatMap((label) => [
        ...label.box.map(u32),
        ...fields(label.text),
      ]),
    ]),
  ]);
}

async function bootstrap(wasmPath, output, trainFontDir, valFontDir, testFontDir) {
  const wasm = await WebAssembly.instantiate(await readFile(wasmPath)).then(
    ({ instance }) => instance,
  );
  await mkdir(output, { recursive: true });
  for (const [split, directory] of [
    ["train", trainFontDir],
    ["val", valFontDir],
    ["test", testFontDir],
  ]) {
    const files = (await readdir(directory)).filter((name) => /\.[ot]tf$/iu.test(name)).sort();
    const clean = [];
    const degraded = [];
    for (const file of files) {
      const font = glyphs(
        render(wasm, await fontSheet(await readFile(join(directory, file)), file.endsWith(".otf"))),
      );
      const missing = labels.filter((label) => !font.has(label));
      if (missing.length) fail(`${basename(file)} missing ${missing.join("")}`);
      if (split === "train") {
        for (const [variant, size] of [15, 19, 24, 29, 38, 47, 55, 62].entries()) {
          for (let index = 0; index < labels.length; index += 24) {
            clean.push(
              compose(
                font,
                labels.slice(index, index + 24).join(" "),
                size,
                variant % 3 !== 0,
                variant,
              ),
            );
          }
        }
        for (const [index, text] of trainingText.entries())
          clean.push(compose(font, text, 30, false, index % 3));
      } else {
        for (const [index, text] of (split === "test" ? testText : evaluationText).entries()) {
          const size = [20, 29, 41, 51][index % 4];
          clean.push(compose(font, text, size, false, index % 4));
          degraded.push(compose(font, text, size, true, index % 4));
        }
      }
    }
    if (!clean.length) fail(`No fonts in ${directory}`);
    await writeFile(join(output, `${split}.ocrt`), await archive(clean).bytes());
    if (degraded.length)
      await writeFile(join(output, `${split}-degraded.ocrt`), await archive(degraded).bytes());
    console.log(
      `${split} ${files.length} faces, ${clean.length} lines, ${degraded.length} degraded lines`,
    );
  }
}

function readPgm(data) {
  let offset = 0;
  const whitespace = (byte) => byte === 32 || (byte >= 9 && byte <= 13);
  const token = () => {
    for (;;) {
      while (whitespace(data[offset])) offset += 1;
      if (data[offset] !== 35) break;
      while (offset < data.length && data[offset] !== 10) offset += 1;
    }
    const start = offset;
    while (offset < data.length && !whitespace(data[offset])) offset += 1;
    return ansi.decode(data.subarray(start, offset));
  };
  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  const payload = width * height;
  const separator = data.length - offset - payload;
  if (
    magic !== "P5" ||
    max !== 255 ||
    ![width, height, payload].every(Number.isSafeInteger) ||
    width < 1 ||
    height < 1 ||
    (separator !== 1 && !(separator === 2 && data[offset] === 13 && data[offset + 1] === 10)) ||
    !whitespace(data[offset])
  ) {
    fail("Invalid binary P5 grayscale image");
  }
  return { width, height, pixels: data.subarray(offset + separator) };
}

function inkBounds({ pixels, width }, box) {
  const [left, top, right, bottom] = box;
  const bounds = [right, bottom, left, top];
  for (let yy = top; yy < bottom; yy += 1) {
    for (let xx = left; xx < right; xx += 1) {
      if (pixels[yy * width + xx] >= 128) continue;
      bounds[0] = Math.min(bounds[0], xx);
      bounds[1] = Math.min(bounds[1], yy);
      bounds[2] = Math.max(bounds[2], xx + 1);
      bounds[3] = Math.max(bounds[3], yy + 1);
    }
  }
  return bounds[0] < bounds[2] && bounds[1] < bounds[3] ? bounds : undefined;
}

function median(items, fallback) {
  items.sort((left, right) => left - right);
  return items[Math.floor(items.length / 2)] ?? fallback;
}

function importLine(raster, words, glyphs) {
  const left = Math.min(...words.map(({ box }) => box[0]));
  const top = Math.min(...words.map(({ box }) => box[1]));
  const right = Math.max(...words.map(({ box }) => box[2]));
  const bottom = Math.max(...words.map(({ box }) => box[3]));
  const contained = glyphs.filter(
    ({ box: [x0, y0, x1, y1] }) => x0 >= left && y0 >= top && x1 <= right && y1 <= bottom,
  );
  const xHeightGlyphs = contained.filter(({ text }) => /^[aceimnorsuvwxz]$/u.test(text));
  const letterInk = xHeightGlyphs.flatMap(({ box }) => {
    const bbox = inkBounds(raster, box);
    return bbox ? [bbox] : [];
  });
  const heights = letterInk.map((box) => box[3] - box[1]);
  const baselineSamples = letterInk.map((box) => box[3] - top);
  const wordInk = words.flatMap(({ box }) => {
    const bbox = inkBounds(raster, box);
    return bbox ? [bbox] : [];
  });
  const width = right - left;
  const height = bottom - top;
  const baseline = median(
    baselineSamples,
    median(
      wordInk.map((box) => box[3] - top),
      height,
    ),
  );
  const xHeight = median(
    heights,
    median(
      wordInk.map((box) => (box[3] - box[1]) * 0.75),
      height * 0.65,
    ),
  );
  const pixels = new Uint8Array(width * height);
  for (let yy = top; yy < bottom; yy += 1) {
    for (let xx = left; xx < right; xx += 1) {
      pixels[(yy - top) * width + xx - left] = Number(raster.pixels[yy * raster.width + xx] < 128);
    }
  }
  const translate = ({ text, box: [x0, y0, x1, y1] }) => ({
    text,
    box: [x0 - left, y0 - top, x1 - left, y1 - top],
  });
  return {
    width,
    height,
    pixels,
    baseline,
    xHeight,
    words: words.map(translate),
    glyphs: contained.map(translate),
  };
}

async function decodeJpeg(path) {
  const process = Bun.spawn(["djpeg", "-grayscale", path], { stdout: "pipe", stderr: "inherit" });
  const [pixels, status] = await Promise.all([
    new Response(process.stdout).bytes(),
    process.exited,
  ]);
  if (status !== 0) fail(`JPEG decoder exited with status ${status}: ${path}`);
  return pixels;
}

async function importDataset(directory, output, jpeg) {
  const samples = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".json")) continue;
    const label = JSON.parse(await readFile(join(directory, name), "utf8"));
    const base = join(directory, name.replace(/\.json$/u, ""));
    const raster = readPgm(jpeg ? await decodeJpeg(`${base}.jpg`) : await readFile(`${base}.pgm`));
    const validBox = ({ box, text }) =>
      Array.isArray(box) &&
      box.length === 4 &&
      box.every(Number.isSafeInteger) &&
      box[0] >= 0 &&
      box[1] >= 0 &&
      box[0] < box[2] &&
      box[2] <= raster.width &&
      box[1] < box[3] &&
      box[3] <= raster.height &&
      typeof text === "string" &&
      text.length > 0;
    const glyphs = label.glyphs ?? [];
    if (
      label.width !== raster.width ||
      label.height !== raster.height ||
      !label.words.every(validBox) ||
      !glyphs.every(validBox)
    ) {
      fail(`Invalid labels in ${name}`);
    }
    const lines = new Map();
    for (const word of label.words) {
      const items = lines.get(word.line) ?? [];
      items.push(word);
      lines.set(word.line, items);
    }
    for (const words of lines.values()) samples.push(importLine(raster, words, glyphs));
  }
  if (!samples.length) fail(`No labeled lines in ${directory}`);
  await writeFile(output, await archive(samples).bytes());
  console.log(
    `imported ${samples.length} lines, ${samples.reduce((count, line) => count + line.glyphs.length, 0)} glyphs`,
  );
}

async function* documents(root, directory = "") {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : Number(left.name !== right.name)));
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory() && entry.name !== "digitalizados") yield* documents(root, relative);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) yield relative;
  }
}

async function extractCorpus(wasmPath, root, destination) {
  const wasm = await WebAssembly.instantiate(await readFile(wasmPath)).then(
    ({ instance }) => instance,
  );
  const pages = [];
  for await (const document of documents(root)) {
    const hash = createHash("sha256").update(document).digest();
    if (hash.readUInt32BE() % 100 >= 80) continue;
    const text = firstPageText(wasm, await readFile(join(root, document)));
    if (text.trim()) pages.push(text);
  }
  if (!pages.length) fail("No text found in the document training split");
  await writeFile(destination, pages.join("\n"));
  console.log(`extracted ${pages.length} pdf-core pages from training documents`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "bootstrap" && args.length === 5) {
  await bootstrap(...args);
} else if (
  command === "import" &&
  (args.length === 2 || (args.length === 3 && args[2] === "--jpeg"))
) {
  await importDataset(args[0], args[1], args[2] === "--jpeg");
} else if (command === "corpus" && args.length === 3) {
  await extractCorpus(...args);
} else {
  console.error(
    "Usage: bun generate.mjs bootstrap <pdf-core.wasm> <out-dir> <train-font-dir> <val-font-dir> <test-font-dir>",
  );
  console.error("       bun generate.mjs import <dataset-split-dir> <output.ocrt> [--jpeg]");
  console.error("       bun generate.mjs corpus <pdf-core.wasm> <native-pdf-root> <corpus.txt>");
  process.exitCode = 2;
}
