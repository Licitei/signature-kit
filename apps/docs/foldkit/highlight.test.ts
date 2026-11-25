import { expect, it } from "vitest";
import { tokenizeCode } from "./highlight";

it("classifies keywords, strings, comments and numbers without losing text", () => {
  const source = 'import { a } from "https://x.dev" // nota\nconst n = 42';
  const tokens = tokenizeCode(source, "ts");
  expect(tokens.map((token) => token.text).join("")).toBe(source);
  expect(tokens.filter((token) => token.kind === "keyword").map((token) => token.text)).toEqual([
    "import",
    "from",
    "const",
  ]);
  expect(tokens.find((token) => token.kind === "string")?.text).toBe('"https://x.dev"');
  expect(tokens.find((token) => token.kind === "comment")?.text).toBe("// nota");
  expect(tokens.find((token) => token.kind === "number")?.text).toBe("42");
});

it("leaves unknown languages untouched and reads shell comments", () => {
  expect(tokenizeCode("const a = 1", "mermaid")).toEqual([{ kind: "plain", text: "const a = 1" }]);
  const shell = tokenizeCode("bun add effect # runtime", "bash");
  expect(shell.find((token) => token.kind === "comment")?.text).toBe("# runtime");
  expect(shell.find((token) => token.kind === "keyword")?.text).toBe("bun");
});
