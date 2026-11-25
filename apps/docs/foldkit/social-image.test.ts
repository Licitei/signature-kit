import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Effect, Result } from "effect";
import { SocialImage, socialImageLayer } from "./social-image";
import type { SocialImageInput } from "./social-image";

const render = (input: unknown) =>
  Effect.gen(function* () {
    const service = yield* SocialImage;
    return yield* service.render(input);
  }).pipe(Effect.provide(socialImageLayer));

const input = {
  title: 'Assinatura <A> & "B"',
  description: "Descrição em português",
  eyebrow: "Documentação",
  site: "signaturekit.dev",
} satisfies SocialImageInput;

const pixels = async (data: Uint8Array) => {
  const image = await loadImage(Buffer.from(data));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: context.getImageData(0, 0, image.width, image.height).data,
  };
};

const differences = (
  left: Uint8ClampedArray,
  right: Uint8ClampedArray,
  start: number,
  end: number,
) => {
  let changed = 0;
  for (let y = start; y < end; y++) {
    for (let x = 0; x < 1200; x++) {
      const offset = (y * 1200 + x) * 4;
      if (
        left[offset] !== right[offset] ||
        left[offset + 1] !== right[offset + 1] ||
        left[offset + 2] !== right[offset + 2]
      )
        changed++;
    }
  }
  return changed;
};

describe("social images", () => {
  it("renders WebP whose title, description, eyebrow and site are each visible", async () => {
    const bytes = await Effect.runPromise(render(input));
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
    const original = await pixels(bytes);
    expect([original.width, original.height]).toEqual([1200, 630]);
    const [title, escapedTitle, description, site, eyebrow] = await Promise.all([
      pixels(await Effect.runPromise(render({ ...input, title: "Assinatura A B" }))),
      pixels(
        await Effect.runPromise(
          render({ ...input, title: "Assinatura &lt;A&gt; &amp; &quot;B&quot;" }),
        ),
      ),
      pixels(await Effect.runPromise(render({ ...input, description: "" }))),
      pixels(await Effect.runPromise(render({ ...input, site: "" }))),
      pixels(await Effect.runPromise(render({ ...input, eyebrow: "Blog" }))),
    ]);
    for (const variant of [title, escapedTitle, description, site, eyebrow]) {
      expect(differences(original.data, variant.data, 150, 630)).toBeGreaterThan(100);
      expect(differences(original.data, variant.data, 0, 120)).toBe(0);
    }
  });

  it("rejects invalid input at the schema boundary", async () => {
    const result = await Effect.runPromise(Effect.result(render({ ...input, title: 42 })));
    expect(Result.isFailure(result)).toBe(true);
  });
});
