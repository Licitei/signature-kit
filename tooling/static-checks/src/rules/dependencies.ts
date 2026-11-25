import type { Check } from "../model";

const hasMandatoryOtelDependency = (line: string): boolean =>
  /"@(?:effect\/opentelemetry|opentelemetry\/[^"/]+)"\s*:/.test(line);

const publicPackageManifestPattern = /^(?:core|shared|runtime)\/[^/]+\/package\.json$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasManifestDependency = (
  context: Parameters<Check["test"]>[0],
  matcher: (line: string) => boolean,
): boolean => {
  if (!matcher(context.rawLine)) {
    return false;
  }
  const parsed = context.parsedJson;
  if (!isRecord(parsed) || !isRecord(parsed.dependencies)) {
    return false;
  }
  return Object.keys(parsed.dependencies).some((name) => matcher(`"${name}":`));
};

const hasManualTypeScriptScript = (context: Parameters<Check["test"]>[0]): boolean => {
  const scriptName = context.rawLine.match(/^\s*"(build|typecheck)"\s*:/)?.[1];
  if (scriptName === undefined) {
    return false;
  }
  const parsed = context.parsedJson;
  return (
    isRecord(parsed) && isRecord(parsed.scripts) && typeof parsed.scripts[scriptName] === "string"
  );
};

export const dependencyChecks: readonly Check[] = [
  {
    message:
      "Public packages must use @nx/js/typescript inferred build and typecheck targets; do not shadow them with package scripts.",
    test: (context) =>
      publicPackageManifestPattern.test(context.path) && hasManualTypeScriptScript(context),
    ignoreImportLine: false,
  },
  {
    message:
      "OpenTelemetry must be optional for the consumer; do not add @effect/opentelemetry or @opentelemetry/* to package dependencies.",
    test: (context) =>
      /^(?:core|runtime)\/[^/]+\/package\.json$/.test(context.path) &&
      hasManifestDependency(context, hasMandatoryOtelDependency),
    ignoreImportLine: false,
  },
];
