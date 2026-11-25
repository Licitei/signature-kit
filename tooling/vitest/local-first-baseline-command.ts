import { defineBrowserCommand } from "@vitest/browser-playwright";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { promisify } from "node:util";

declare module "vitest/browser" {
  interface BrowserCommands {
    writeLocalFirstBaseline: (measurements: object) => Promise<string>;
  }
}

const run = promisify(execFile);

export const writeLocalFirstBaseline = defineBrowserCommand(
  async ({ page }, measurements: object) => {
    const cwd = new URL("../../", import.meta.url);
    const [{ stdout: commit }, { stdout: bun }] = await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd }),
      run("bun", ["--version"], { cwd }),
    ]);
    const cores = cpus();
    const environment = {
      commit: commit.trim(),
      cpu: cores[0]?.model,
      logicalCores: cores.length,
      ramBytes: totalmem(),
      os: `${process.platform} ${release()} ${process.arch}`,
      chromium: page.context().browser()?.version(),
      bun: bun.trim(),
      node: process.version,
    };
    const output = new URL(".cache/local-first/", cwd);
    await mkdir(output, { recursive: true });
    const result = new URL("chromium.json", output);
    await writeFile(result, JSON.stringify({ environment, measurements }, null, 2) + "\n");
    return result.pathname;
  },
);
