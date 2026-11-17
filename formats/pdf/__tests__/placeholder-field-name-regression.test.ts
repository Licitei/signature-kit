import { describe, expect, it } from "@effect/vitest";
import type { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect, Result } from "effect";
import { PdfErrorCodeValue, PdfOperationValue } from "../src/config";
import { addSignaturePlaceholder } from "../src/placeholder";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import {
  acroFormField,
  acroFormFieldNumbers,
  acroFormFixture,
  objectSource,
  pdfStringEntry,
  ref,
} from "./pdf-fixtures";

const createPdfWithNestedSignatureKitName = acroFormFixture((next) => {
  const child = next();
  const root = next();
  return {
    objects: [
      [child, "<< /T (SignatureKitSignature1) >>"],
      [root, `<< /Kids [${ref(child)}] >>`],
    ],
    fields: [root],
  };
});

const createPdfWithDeepFieldHierarchy = () =>
  acroFormFixture((next) => {
    const refs = Array.from({ length: 66 }, () => next());
    return {
      objects: refs.map((current, depth) => {
        const kid = refs[depth + 1];
        const name = depth === 0 ? "root" : `field-${depth}`;
        return [current, `<< /T (${name})${kid === undefined ? "" : ` /Kids [${ref(kid)}]`} >>`];
      }),
      fields: refs.slice(0, 1),
    };
  });

const createPdfWithCyclicFieldHierarchy = () =>
  acroFormFixture((next) => {
    const root = next();
    return { objects: [[root, `<< /T (root) /Kids [${ref(root)}] >>`]], fields: [root] };
  });

const createPdfWithNamedFields = (names: ReadonlyArray<string>) =>
  acroFormFixture((next) => {
    const refs = names.map(() => next());
    return {
      objects: refs.map((current, index) => [current, `<< /T (${names[index] ?? ""}) >>`]),
      fields: refs,
    };
  });

const createPdfWithWideFieldHierarchy = (fieldCount: number) =>
  createPdfWithNamedFields(Array.from({ length: fieldCount }, (_, index) => `field-${index}`));

const expectInvalidPdfPlaceholder = (
  pdf: Uint8Array,
  reason: string,
): Effect.Effect<void, never, PdfCore> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(addSignaturePlaceholder({ pdf, signatureLength: 128 }));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("PdfError");
      expect(result.failure.code).toBe(PdfErrorCodeValue.invalidPdf);
      expect(result.failure.operation).toBe(PdfOperationValue.placeholder);
      expect(result.failure.retryable).toBe(false);
      expect(result.failure.reason).toBe(reason);
    }
  });

describe("PDF placeholder field names", () => {
  it.effect("uses the first unused hierarchical field name for repeated placeholders", () =>
    Effect.gen(function* () {
      const source = yield* createPdfWithNestedSignatureKitName;
      const first = yield* addSignaturePlaceholder({ pdf: source, signatureLength: 128 });
      const second = yield* addSignaturePlaceholder({ pdf: first, signatureLength: 128 });
      const root = acroFormField(second, 0);
      const nestedNumber = /\/Kids\s*\[\s*(\d+)\s+\d+\s+R/u.exec(root)?.[1];
      const nested =
        nestedNumber === undefined ? "" : (objectSource(second, Number(nestedNumber)) ?? "");
      const firstSignature = acroFormField(second, 1);
      const secondSignature = acroFormField(second, 2);

      expect(acroFormFieldNumbers(second)).toHaveLength(3);
      expect(pdfStringEntry(nested, "T")).toBe("SignatureKitSignature1");
      expect(pdfStringEntry(firstSignature, "T")).toBe("SignatureKitSignature2");
      expect(pdfStringEntry(secondSignature, "T")).toBe("SignatureKitSignature3");
      expect(firstSignature).toMatch(/\/V\s+\d+\s+\d+\s+R/u);
      expect(secondSignature).toMatch(/\/V\s+\d+\s+\d+\s+R/u);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("accepts a hierarchy at the supported node budget", () =>
    Effect.gen(function* () {
      const source = yield* createPdfWithWideFieldHierarchy(10_000);
      const prepared = yield* addSignaturePlaceholder({ pdf: source, signatureLength: 128 });
      expect(acroFormFieldNumbers(prepared)).toHaveLength(10_001);
      expect(pdfStringEntry(acroFormField(prepared, 10_000), "T")).toBe("SignatureKitSignature1");
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("fails closed when a field hierarchy exceeds the node budget", () =>
    Effect.gen(function* () {
      const source = yield* createPdfWithWideFieldHierarchy(10_001);

      yield* expectInvalidPdfPlaceholder(
        source,
        "Signature field hierarchy exceeds the supported node budget.",
      );
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("fails closed when a field hierarchy exceeds the depth budget", () =>
    Effect.gen(function* () {
      const source = yield* createPdfWithDeepFieldHierarchy();

      yield* expectInvalidPdfPlaceholder(
        source,
        "Signature field hierarchy exceeds the supported depth.",
      );
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("fails closed for a cyclic field hierarchy", () =>
    Effect.gen(function* () {
      const source = yield* createPdfWithCyclicFieldHierarchy();

      yield* expectInvalidPdfPlaceholder(source, "Signature field hierarchy is cyclic.");
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("fails closed when processing an oversized field name", () =>
    Effect.gen(function* () {
      const source = yield* createPdfWithNamedFields(["name".repeat(1_025)]);

      yield* expectInvalidPdfPlaceholder(
        source,
        "Signature field name exceeds the supported length.",
      );
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("fails closed when aggregate field-name processing exceeds its budget", () =>
    Effect.gen(function* () {
      const source = yield* createPdfWithNamedFields(
        Array.from({ length: 123 }, (_, index) => `${index}`.padEnd(4_096, "name")),
      );

      yield* expectInvalidPdfPlaceholder(
        source,
        "Signature field names exceed the supported processing budget.",
      );
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
