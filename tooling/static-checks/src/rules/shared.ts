import { adapterOrPackagePathPrefixes } from "../config";

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isLibraryFile = (path: string): boolean =>
  adapterOrPackagePathPrefixes.some((prefix) => path.startsWith(prefix));

export const isTaggedErrorName = (name: string): boolean => {
  const raw = name.replace(/\s*<[\s\S]*$/, "");
  return /(^|\.)TaggedError$/.test(raw);
};

export const isCatalogFile = (path: string): boolean =>
  path.endsWith("/config.ts") ||
  path.endsWith("/manifest.ts") ||
  path.endsWith("/observability.ts") ||
  path.endsWith("/schemas.ts");
