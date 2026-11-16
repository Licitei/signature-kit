import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = join(scriptsDir, "../../..");

export const workspaceModuleUrl = (
  ...segments: readonly string[]
): string => pathToFileURL(join(repoRoot, ...segments)).href;