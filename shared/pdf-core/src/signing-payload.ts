import { PdfCoreRevisionChangeKindSchema } from "./config.js";
import type { PdfCorePrepareSignatureRequest } from "./config.js";

const utf8Encoder = new TextEncoder();
const utf8 = new TextDecoder();

export type PayloadWriter = {
  readonly f64: (value: number) => void;
  readonly u32: (value: number) => void;
  readonly bytes: (value: Uint8Array) => void;
  readonly text: (value: string) => void;
  readonly finish: () => Uint8Array;
};

export const payloadWriter = (): PayloadWriter => {
  const parts: Array<Uint8Array> = [];
  let length = 0;
  const push = (part: Uint8Array): void => {
    parts.push(part);
    length += part.byteLength;
  };
  const u32 = (value: number): void => {
    const word = new Uint8Array(4);
    new DataView(word.buffer).setUint32(0, value >>> 0, true);
    push(word);
  };
  return {
    u32,
    f64: (value) => {
      const word = new Uint8Array(8);
      new DataView(word.buffer).setFloat64(0, value, true);
      push(word);
    },
    bytes: (value) => {
      u32(value.byteLength);
      push(value);
    },
    text: (value) => {
      const encoded = utf8Encoder.encode(value);
      u32(encoded.byteLength);
      push(encoded);
    },
    finish: () => {
      const out = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    },
  };
};

const prepareMagic = 0x52505350;
const fieldsMagic = 0x46435350;
const preparedMagic = 0x4f505350;
const changesMagic = 0x48435350;
const absentPage = 0xffffffff;

export const encodePrepareSignature = (request: PdfCorePrepareSignatureRequest): Uint8Array => {
  const writer = payloadWriter();
  writer.u32(prepareMagic);
  writer.u32(1);
  const { field, appearance, lock } = request;
  writer.u32(field.kind === "create" ? 1 : 0);
  writer.text(field.name);
  if (field.kind === "create") {
    writer.u32(field.page);
    field.rect.forEach(writer.f64);
  }
  writer.u32(request.contentsCapacity);
  writer.u32(request.subFilter === "adbe.pkcs7.detached" ? 1 : 0);
  writer.u32(request.sha512 === true ? 1 : 0);
  writer.u32(request.docMdp ?? 0);
  writer.text(request.date);
  for (const value of [request.reason, request.location, request.contactInfo]) {
    writer.u32(value === undefined ? 0 : 1);
    if (value !== undefined) writer.text(value);
  }
  const lockActions = { All: 1, Include: 2, Exclude: 3 };
  writer.u32(lock === undefined ? 0 : lockActions[lock.action]);
  if (lock !== undefined) {
    const fields = lock.action === "All" ? [] : lock.fields;
    writer.u32(fields.length);
    fields.forEach(writer.text);
  }
  writer.u32(appearance.kind === "visible" ? 1 : 0);
  if (appearance.kind === "visible") {
    writer.u32(appearance.lines.length);
    for (const line of appearance.lines) {
      writer.u32(line.font === "Helvetica-Bold" ? 1 : 0);
      writer.f64(line.size);
      line.position.forEach(writer.f64);
      writer.u32(line.color.length);
      line.color.forEach(writer.f64);
      writer.text(line.text);
    }
    writer.u32(appearance.border === undefined ? 0 : 1);
    if (appearance.border !== undefined) {
      writer.f64(appearance.border.width);
      writer.u32(appearance.border.color.length);
      appearance.border.color.forEach(writer.f64);
    }
    writer.u32(appearance.image === undefined ? 0 : 1);
    if (appearance.image !== undefined) {
      appearance.image.rect.forEach(writer.f64);
      writer.bytes(appearance.image.png);
    }
  }
  return writer.finish();
};

class PayloadReader {
  private offset = 0;
  private failed = false;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private consume(length: number): number | undefined {
    const start = this.offset;
    const end = start + length;
    if (this.failed || end > this.bytes.byteLength) {
      this.failed = true;
      return undefined;
    }
    this.offset = end;
    return start;
  }

  u32(): number {
    const start = this.consume(4);
    return start === undefined ? 0 : this.view.getUint32(start, true);
  }

  f64(): number {
    const start = this.consume(8);
    return start === undefined ? 0 : this.view.getFloat64(start, true);
  }

  raw(length: number): Uint8Array {
    const start = this.consume(length);
    return start === undefined ? new Uint8Array() : this.bytes.subarray(start, this.offset);
  }

  text(): string {
    return utf8.decode(this.raw(this.u32()));
  }

  list<A>(minimumItemBytes: number, read: () => A): Array<A> {
    const length = this.u32();
    if (length * minimumItemBytes > this.bytes.byteLength - this.offset) {
      this.failed = true;
      return [];
    }
    const items: Array<A> = [];
    for (let i = 0; i < length && !this.failed; i += 1) items.push(read());
    return items;
  }

  ref() {
    const number = this.u32();
    const generation = this.u32();
    return number === 0 ? undefined : { number, generation };
  }

  header(magic: number): boolean {
    return this.u32() === magic && this.u32() === 1;
  }

  done(): boolean {
    return !this.failed && this.offset === this.bytes.byteLength;
  }
}

const readField = (reader: PayloadReader) => {
  const name = reader.text();
  const ref = reader.ref();
  const flags = reader.u32();
  const signature =
    (flags & 2) === 0
      ? undefined
      : {
          byteRange:
            reader.u32() === 0
              ? undefined
              : [reader.f64(), reader.f64(), reader.f64(), reader.f64()],
          revisionEnd: reader.u32() || undefined,
          subFilter: reader.text() || undefined,
        };
  const lock =
    (flags & 4) === 0
      ? undefined
      : {
          action: reader.text() || undefined,
          fields: reader.list(4, () => reader.text()),
        };
  const widgets = reader.list(16, () => {
    const widgetRef = reader.ref();
    const page = reader.u32();
    const rect =
      reader.u32() === 0 ? undefined : [reader.f64(), reader.f64(), reader.f64(), reader.f64()];
    return { ref: widgetRef, page: page === absentPage ? undefined : page, rect };
  });
  return { name, ref, signed: (flags & 1) !== 0, signature, lock, widgets };
};

export const decodeSignatureFields = (bytes: Uint8Array) => {
  const reader = new PayloadReader(bytes);
  if (!reader.header(fieldsMagic)) return undefined;
  const docMdp = reader.u32() || undefined;
  const revisions = reader.list(4, () => reader.u32());
  const fields = reader.list(20, () => readField(reader));
  return reader.done() ? { docMdp, revisions, fields } : undefined;
};

export const decodePreparedSignature = (bytes: Uint8Array) => {
  const reader = new PayloadReader(bytes);
  if (!reader.header(preparedMagic)) return undefined;
  const byteRange = [reader.u32(), reader.u32(), reader.u32(), reader.u32()];
  const contentsStart = reader.u32();
  const contentsEnd = reader.u32();
  const sha256 = reader.raw(32);
  const sha512 = reader.raw(reader.u32());
  const pdf = reader.raw(reader.u32());
  return reader.done() && (sha512.byteLength === 0 || sha512.byteLength === 64)
    ? {
        pdf,
        byteRange,
        contentsStart,
        contentsEnd,
        sha256,
        sha512: sha512.byteLength === 0 ? undefined : sha512,
      }
    : undefined;
};

export const decodePreparedUpdate = (bytes: Uint8Array) => {
  const reader = new PayloadReader(bytes);
  if (!reader.header(0x55505350)) return undefined;
  const byteRange = [reader.u32(), reader.u32(), reader.u32(), reader.u32()];
  const contentsStart = reader.u32();
  const contentsEnd = reader.u32();
  const appendix = reader.raw(reader.u32());
  return reader.done() ? { byteRange, contentsStart, contentsEnd, appendix } : undefined;
};

export const decodeRevisionChanges = (bytes: Uint8Array) => {
  const reader = new PayloadReader(bytes);
  if (!reader.header(changesMagic)) return undefined;
  const pageContentChanged = reader.u32() === 1;
  const changes = reader.list(20, () => {
    const ref = reader.ref();
    const kind = PdfCoreRevisionChangeKindSchema.literals[reader.u32()];
    const status = reader.u32();
    const change = status === 1 ? "added" : status === 2 ? "removed" : "modified";
    return { ref, kind, change, revisionEnd: reader.u32() };
  });
  return reader.done() ? { changes, pageContentChanged } : undefined;
};
