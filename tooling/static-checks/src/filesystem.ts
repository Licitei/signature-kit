import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  checkedExtensions,
  packageToolingPathPattern,
  skippedSegments,
  skippedSuffixes,
} from "./config";

export const hasCheckedExtension = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && checkedExtensions[path.slice(dot)] === true;
};

export const shouldSkip = (path: string): boolean => {
  const parts = path.split("/");
  return (
    parts.some((part) => skippedSegments[part] === true) ||
    skippedSuffixes.some((suffix) => path.endsWith(suffix)) ||
    packageToolingPathPattern.test(path)
  );
};

export function* walk(root: string, workspace: string): Generator<string> {
  const displayPath = relative(workspace, root).replaceAll("\\", "/");
  if (shouldSkip(displayPath)) return;

  const stats = statSync(root);
  if (stats.isFile() && hasCheckedExtension(displayPath)) {
    yield root;
  } else if (stats.isDirectory()) {
    for (const entry of readdirSync(root)) {
      yield* walk(join(root, entry), workspace);
    }
  }
}
