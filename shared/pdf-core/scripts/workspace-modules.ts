import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = join(scriptsDir, "../../..");

export const workspaceModuleUrl = (
  ...segments: readonly string[]
): string => pathToFileURL(join(repoRoot, ...segments)).href;

export const bunStorePackageRoot = (prefix: string): string => {
  const packageDir = readdirSync(join(repoRoot, "node_modules/.bun")).find((entry) =>
    entry.startsWith(`${prefix}@`),
  );
  if (packageDir === undefined) {
    throw new Error(`${prefix} is not installed in the workspace.`);
  }
  return join(repoRoot, "node_modules/.bun", packageDir, `node_modules/${prefix}`);
};