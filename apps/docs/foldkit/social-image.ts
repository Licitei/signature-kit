import { Context, Effect, Layer, Schema } from "effect";
import { Renderer } from "takumi-js/node";
import type { Node } from "takumi-js/node";
import geistFont from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline";
import geistMonoFont from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?inline";
import heroArt from "../public/landing/hero-chapada.webp?inline";
import liciteiLogo from "../public/landing/licitei.webp?inline";

export const SocialImageInput = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  eyebrow: Schema.optional(Schema.String),
  site: Schema.String,
});
export type SocialImageInput = typeof SocialImageInput.Type;

const brandMark =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 22"><path d="M2 15c3 0 4-10 7-10s-2 12 2 12 3-8 6-8-1 6 2 6 3-4 6-4 2 2 4 2" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="31.5" cy="13" r="2.2" fill="#FF884B"/></svg>';

const dataBytes = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

export const socialImageTree = (input: SocialImageInput): Node => ({
  type: "container",
  lang: "pt-BR",
  style: {
    position: "relative",
    display: "flex",
    width: "100%",
    height: "100%",
    backgroundColor: "#0a3d58",
    color: "#ffffff",
    fontFamily: "Geist Variable",
  },
  children: [
    {
      type: "image",
      src: "hero",
      style: {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: "center bottom",
        imageRendering: "pixelated",
      },
    },
    {
      type: "container",
      style: {
        position: "absolute",
        inset: 0,
        backgroundImage:
          "linear-gradient(90deg, rgba(6, 30, 43, 0.97) 0%, rgba(6, 30, 43, 0.9) 52%, rgba(6, 30, 43, 0.45) 100%)",
      },
      children: [],
    },
    {
      type: "container",
      style: {
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: "64px 72px",
      },
      children: [
        {
          type: "container",
          style: { display: "flex", alignItems: "center", gap: "14px" },
          children: [
            { type: "image", src: "brand", style: { width: "46px", height: "30px" } },
            {
              type: "text",
              text: "SignatureKit",
              style: { fontSize: "30px", fontWeight: 600, letterSpacing: "-0.02em" },
            },
            {
              type: "text",
              text: "Apoiado pela",
              style: {
                marginLeft: "auto",
                color: "rgba(255, 255, 255, 0.72)",
                fontSize: "20px",
              },
            },
            {
              type: "image",
              src: "licitei",
              style: { width: "88px", height: "19px", filter: "brightness(0) invert(1)" },
            },
          ],
        },
        ...(input.eyebrow !== undefined && input.eyebrow.length > 0
          ? [
              {
                type: "text",
                text: input.eyebrow,
                style: {
                  marginTop: "auto",
                  color: "#FF884B",
                  fontSize: "22px",
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                },
              } satisfies Node,
            ]
          : []),
        {
          type: "text",
          text: input.title,
          style: {
            marginTop: input.eyebrow !== undefined && input.eyebrow.length > 0 ? "14px" : "auto",
            maxWidth: "940px",
            fontSize: "66px",
            fontWeight: 650,
            lineHeight: 1.04,
            letterSpacing: "-0.04em",
            lineClamp: 3,
          },
        },
        ...(input.description !== undefined && input.description.length > 0
          ? [
              {
                type: "text",
                text: input.description,
                style: {
                  marginTop: "22px",
                  maxWidth: "820px",
                  color: "rgba(255, 255, 255, 0.78)",
                  fontSize: "26px",
                  lineHeight: 1.4,
                  lineClamp: 2,
                },
              } satisfies Node,
            ]
          : []),
        {
          type: "text",
          text: input.site,
          style: {
            marginTop: "36px",
            color: "rgba(255, 255, 255, 0.62)",
            fontFamily: "Geist Mono Variable",
            fontSize: "20px",
          },
        },
      ],
    },
  ],
});

export class SocialImage extends Context.Service<
  SocialImage,
  {
    readonly render: (input: unknown) => Effect.Effect<Uint8Array, Schema.SchemaError>;
  }
>()("docs/SocialImage") {}

export const socialImageLayer = Layer.effect(
  SocialImage,
  Effect.promise(async () => {
    const renderer = new Renderer();
    await renderer.registerFont({ name: "Geist Variable", data: dataBytes(geistFont) });
    await renderer.registerFont({ name: "Geist Mono Variable", data: dataBytes(geistMonoFont) });
    const images = [
      { src: "hero", data: dataBytes(heroArt) },
      { src: "licitei", data: dataBytes(liciteiLogo) },
      { src: "brand", data: new TextEncoder().encode(brandMark) },
    ];
    return SocialImage.of({
      render: Effect.fn(function* (input: unknown) {
        const data = yield* Schema.decodeUnknownEffect(SocialImageInput)(input);
        return yield* Effect.promise((signal) =>
          renderer.render(socialImageTree(data), {
            width: 1200,
            height: 630,
            format: "webp",
            quality: 88,
            images,
            signal,
          }),
        );
      }),
    });
  }),
);
