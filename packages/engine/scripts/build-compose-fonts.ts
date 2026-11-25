import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { Base64 } from "effect/encoding";

const font = (name: string) =>
  new URL(
    `../assets/fonts/IBMPlexSans-${name}.${name === "Italic" ? "otf" : "ttf"}`,
    import.meta.url,
  );
const out = new URL("../dist/wasm/", import.meta.url);
await mkdir(out, { recursive: true });
const declarations = await Promise.all(
  ["Regular", "Medium", "Bold", "Italic"].map(async (name) => {
    const data = Base64.encode(await readFile(font(name)));
    return `export const ${name.toLowerCase()} = "${data}";\n`;
  }),
);
await writeFile(new URL("compose-fonts.mjs", out), declarations.join(""));
await copyFile(
  new URL("../assets/fonts/OFL.txt", import.meta.url),
  new URL("IBM-Plex-OFL.txt", out),
);
