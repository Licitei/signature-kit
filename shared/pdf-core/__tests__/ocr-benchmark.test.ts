import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeTsv, median } from "../bench/ocr/engines.ts";
import {
  editDistance,
  intersectionOverUnion,
  scorePage,
  summarizeScores,
} from "../bench/ocr/metrics.ts";
import type { Recognition, Reference } from "../bench/ocr/metrics.ts";

function referenceEngine(reference: Reference): Recognition {
  return {
    width: reference.width,
    height: reference.height,
    text: reference.text,
    words: reference.words?.map((word) => ({ ...word, confidence: 1 })) ?? [],
  };
}

const reference: Reference = {
  id: "fixture",
  dpi: 150,
  width: 100,
  height: 50,
  source: "test",
  degradation: {},
  text: "Ação pública\nAção",
  words: [
    { text: "Ação", box: [0, 0, 10, 10], line: 0 },
    { text: "pública", box: [11, 0, 24, 10], line: 0 },
    { text: "Ação", box: [0, 11, 10, 21], line: 1 },
  ],
};

describe("OCR benchmark metrics", () => {
  it("scores an exact reference-engine result without errors", () => {
    expect(summarizeScores([scorePage(reference, referenceEngine(reference))])).toEqual({
      raw: { cer: 0, wer: 0 },
      normalized: { cer: 0, wer: 0 },
      bag: { precision: 1, recall: 1, f1: 1 },
      boxes: { precision: 1, recall: 1, f1: 1 },
      boxesWithText: { precision: 1, recall: 1, f1: 1 },
    });
  });

  it("normalizes canonical Unicode and keeps accent errors", () => {
    const prediction = referenceEngine(reference);
    const canonical = scorePage(reference, {
      ...prediction,
      text: reference.text.normalize("NFD"),
    });
    expect(canonical.raw.characterEdits).toBe(0);
    const score = scorePage(reference, { ...prediction, text: "ACÃO   PÚBLICA\tAÇÃO" });
    expect(score.raw.wordEdits).toBe(3);
    expect(score.normalized.characterEdits).toBe(1);
    expect(score.normalized.wordEdits).toBe(1);
    expect(editDistance(Array.from("a😀"), Array.from("a😃"))).toBe(1);
  });

  it("counts repeated words once per occurrence and ignores order only in bag F1", () => {
    const prediction = { ...referenceEngine(reference), text: "pública Ação pública" };
    const reordered = scorePage(reference, { ...prediction, text: "pública Ação Ação" });
    const score = scorePage(reference, prediction);
    expect(reordered.normalized.wordEdits).toBe(2);
    expect(reordered.bag).toEqual({ matched: 3, expected: 3, predicted: 3 });
    expect(score.bag).toEqual({ matched: 2, expected: 3, predicted: 3 });
  });

  it("reports geometry and transcription independently with one-to-one matching", () => {
    const prediction = referenceEngine(reference);
    const word = {
      text: "Acao",
      box: [0, 0, 5, 10],
      line: 0,
      confidence: 0.25,
    } satisfies Recognition["words"][number];
    expect(intersectionOverUnion([0, 0, 10, 10], word.box)).toBe(0.5);
    const score = scorePage(reference, { ...prediction, words: [word, { ...word, text: "Ação" }] });
    expect(score.boxes).toEqual({ matched: 1, expected: 3, predicted: 2 });
    expect(score.boxesWithText).toEqual({ matched: 1, expected: 3, predicted: 2 });

    const wrongText = summarizeScores([scorePage(reference, { ...prediction, words: [word] })]);
    expect(wrongText.boxes).toEqual({ precision: 1, recall: 1 / 3, f1: 0.5 });
    expect(wrongText.boxesWithText?.f1).toBe(0);
  });

  it("leaves an unannotated page out of the box denominator and micro-averages edit counts", () => {
    const prediction = referenceEngine(reference);
    const subset = { text: "ab" };
    const scores = [
      scorePage(subset, { ...prediction, text: "ba" }),
      scorePage({ text: "12345678" }, { ...prediction, text: "12345678" }),
    ];
    expect(summarizeScores(scores).raw).toEqual({ cer: 0.2, wer: 0.5 });
    expect(summarizeScores(scores).boxes).toBeNull();
    expect(summarizeScores([scorePage({ text: "" }, prediction)]).raw.cer).toBeNull();
  });

  it("preserves block and paragraph boundaries in Tesseract's flattened word order", async () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t3\t5\t8\t9\t75.5\tSão",
      "5\t1\t1\t1\t1\t2\t12\t5\t14\t9\t0\tJoão",
      "5\t1\t2\t1\t1\t1\t3\t15\t4\t9\t100\tOlá",
    ].join("\n");
    const parsed = await Effect.runPromise(decodeTsv(tsv, 100, 100));
    expect(parsed.text).toBe("São João\nOlá");
    expect(parsed.words[0]).toEqual({
      text: "São",
      box: [3, 5, 11, 14],
      line: 0,
      confidence: 0.755,
    });
    expect(median([50, 1, 10])).toBe(10);
    expect(median([50, 1, 10, 20])).toBe(15);
  });
});
