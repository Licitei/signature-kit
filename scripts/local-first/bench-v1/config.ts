import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Option, Schema } from "effect";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const output = resolve(root, ".cache/bench-v1");

const manifestSchema = Schema.Struct({
  name: Schema.String,
  exports: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Struct({ import: Schema.String })]),
    ),
  ),
});

export const benchmarkAliases = () =>
  Object.fromEntries(
    globSync(
      ["core", "formats", "shared", "signers", "apps"].map((dir) => `${dir}/*/package.json`),
      { cwd: root },
    )
      .flatMap((file) => {
        const raw: unknown = JSON.parse(readFileSync(resolve(root, file), "utf8"));
        if (file === "apps/docs/package.json") return [];
        const manifest = Option.getOrThrow(Schema.decodeUnknownOption(manifestSchema)(raw));
        return Object.entries(manifest.exports ?? {}).map(([key, target]) => [
          key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`,
          resolve(root, file, "..", typeof target === "string" ? target : target.import),
        ]);
      })
      .sort(([left = ""], [right = ""]) => right.length - left.length),
  );
