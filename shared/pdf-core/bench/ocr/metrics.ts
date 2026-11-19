import { Schema } from "effect";

const Pixel = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Dimension = Schema.Int.check(Schema.isGreaterThan(0));
const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const BoxSchema = Schema.Tuple([Pixel, Pixel, Pixel, Pixel]).check(
  Schema.makeFilter(([left, top, right, bottom]) => left < right && top < bottom),
);
const WordSchema = Schema.Struct({ text: Schema.String, box: BoxSchema, line: Pixel });

export const ReferenceSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)),
  source: Schema.String,
  dpi: Dimension,
  width: Dimension,
  height: Dimension,
  degradation: Schema.Record(Schema.String, Schema.Unknown),
  text: Schema.String,
  words: Schema.optional(Schema.Array(WordSchema)),
  imageSha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});

export const RecognitionSchema = Schema.Struct({
  width: Dimension,
  height: Dimension,
  text: Schema.String,
  words: Schema.Array(Schema.Struct({ ...WordSchema.fields, confidence: Confidence })),
});

export type Box = typeof BoxSchema.Type;
export type Reference = typeof ReferenceSchema.Type;
export type Recognition = typeof RecognitionSchema.Type;
type Word = typeof WordSchema.Type;

export function editDistance<T>(reference: readonly T[], prediction: readonly T[]): number {
  let previous = Array.from({ length: prediction.length + 1 }, (_, index) => index);
  for (const [index, expected] of reference.entries()) {
    const row = [index + 1];
    for (const [column, actual] of prediction.entries()) {
      if (expected === actual) {
        row.push(previous[column] ?? 0);
      } else {
        row.push(1 + Math.min(row[column] ?? 0, previous[column] ?? 0, previous[column + 1] ?? 0));
      }
    }
    previous = row;
  }
  return previous[prediction.length] ?? 0;
}

function normalized(text: string) {
  return text.normalize("NFC").trim().replaceAll(/\s+/gu, " ").toLowerCase().normalize("NFC");
}

function tokens(text: string) {
  return text.match(/\S+/gu) ?? [];
}

function textCounts(reference: string, prediction: string) {
  const characters = Array.from(reference);
  const words = tokens(reference);
  return {
    characterEdits: editDistance(characters, Array.from(prediction)),
    characters: characters.length,
    wordEdits: editDistance(words, tokens(prediction)),
    words: words.length,
  };
}

export function intersectionOverUnion(
  [left, top, right, bottom]: Box,
  [otherLeft, otherTop, otherRight, otherBottom]: Box,
) {
  const width = Math.max(0, Math.min(right, otherRight) - Math.max(left, otherLeft));
  const height = Math.max(0, Math.min(bottom, otherBottom) - Math.max(top, otherTop));
  const intersection = width * height;
  return (
    intersection /
    ((right - left) * (bottom - top) +
      (otherRight - otherLeft) * (otherBottom - otherTop) -
      intersection)
  );
}

function boxMatches(reference: readonly Word[], prediction: readonly Word[], compareText: boolean) {
  const candidates = reference.flatMap((word, referenceIndex) =>
    prediction.flatMap((actual, predictionIndex) => {
      if (compareText && word.text.normalize("NFC") !== actual.text.normalize("NFC")) {
        return [];
      }
      const iou = intersectionOverUnion(word.box, actual.box);
      return iou >= 0.5 ? [{ iou, referenceIndex, predictionIndex }] : [];
    }),
  );
  candidates.sort((first, second) => second.iou - first.iou);
  const matchedReferences = new Set<number>();
  const matchedPredictions = new Set<number>();
  for (const { referenceIndex, predictionIndex } of candidates) {
    if (!matchedReferences.has(referenceIndex) && !matchedPredictions.has(predictionIndex)) {
      matchedReferences.add(referenceIndex);
      matchedPredictions.add(predictionIndex);
    }
  }
  return matchedReferences.size;
}

function bagMatches(reference: readonly string[], prediction: readonly string[]) {
  const counts = new Map<string, number>();
  for (const word of reference) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let matched = 0;
  for (const word of prediction) {
    const count = counts.get(word) ?? 0;
    if (count > 0) {
      matched += 1;
      counts.set(word, count - 1);
    }
  }
  return matched;
}

export function scorePage(reference: Pick<Reference, "text" | "words">, prediction: Recognition) {
  const plainReference = reference.text.normalize("NFC");
  const plainPrediction = prediction.text.normalize("NFC");
  const normalizedReference = normalized(plainReference);
  const normalizedPrediction = normalized(plainPrediction);
  const referenceTokens = tokens(normalizedReference);
  const predictionTokens = tokens(normalizedPrediction);
  const boxes = reference.words;
  return {
    raw: textCounts(plainReference, plainPrediction),
    normalized: textCounts(normalizedReference, normalizedPrediction),
    bag: {
      matched: bagMatches(referenceTokens, predictionTokens),
      expected: referenceTokens.length,
      predicted: predictionTokens.length,
    },
    boxes:
      boxes === undefined
        ? null
        : {
            matched: boxMatches(boxes, prediction.words, false),
            expected: boxes.length,
            predicted: prediction.words.length,
          },
    boxesWithText:
      boxes === undefined
        ? null
        : {
            matched: boxMatches(boxes, prediction.words, true),
            expected: boxes.length,
            predicted: prediction.words.length,
          },
  };
}

type Counts = { readonly matched: number; readonly expected: number; readonly predicted: number };
export type PageScore = ReturnType<typeof scorePage>;

function precisionRecall(counts: readonly Counts[]) {
  if (counts.length === 0) {
    return null;
  }
  const expected = counts.reduce((sum, count) => sum + count.expected, 0);
  const predicted = counts.reduce((sum, count) => sum + count.predicted, 0);
  const matched = counts.reduce((sum, count) => sum + count.matched, 0);
  return {
    precision: predicted === 0 ? Number(expected === 0) : matched / predicted,
    recall: expected === 0 ? Number(predicted === 0) : matched / expected,
    f1: expected + predicted === 0 ? 1 : (2 * matched) / (expected + predicted),
  };
}

function errorRates(counts: readonly ReturnType<typeof textCounts>[]) {
  const characters = counts.reduce((sum, count) => sum + count.characters, 0);
  const words = counts.reduce((sum, count) => sum + count.words, 0);
  return {
    cer:
      characters === 0
        ? null
        : counts.reduce((sum, count) => sum + count.characterEdits, 0) / characters,
    wer: words === 0 ? null : counts.reduce((sum, count) => sum + count.wordEdits, 0) / words,
  };
}

export function summarizeScores(scores: readonly PageScore[]) {
  return {
    raw: errorRates(scores.map((score) => score.raw)),
    normalized: errorRates(scores.map((score) => score.normalized)),
    bag: precisionRecall(scores.map((score) => score.bag)),
    boxes: precisionRecall(scores.flatMap((score) => score.boxes ?? [])),
    boxesWithText: precisionRecall(scores.flatMap((score) => score.boxesWithText ?? [])),
  };
}
