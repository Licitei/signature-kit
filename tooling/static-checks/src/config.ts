export const checkedExtensions: Record<string, true> = {
  ".cjs": true,
  ".js": true,
  ".json": true,
  ".jsx": true,
  ".mjs": true,
  ".mdx": true,
  ".ts": true,
  ".tsx": true,
};

export const skippedSegments: Record<string, true> = {
  ".next": true,
  dist: true,
  node_modules: true,
  outputs: true,
  target: true,
};
export const skippedSuffixes: readonly string[] = [".d.ts", ".tsbuildinfo", "README.md"];

export const packageToolingPathPattern =
  /(?:^|\/)(?:core|shared|runtime)\/[^/]+\/(?:scripts|bench)\//;

export const roots = ["core", "shared", "runtime"];

export const promiseBoundaryModules: readonly string[] = [
  "shared/pdf-core/src/promise.ts",
  "shared/pdf-core/src/node.ts",
];

export const nodeBoundaryModules: readonly string[] = ["shared/pdf-core/src/node.ts"];

export const allowedEffectProvideSites: Record<string, readonly string[]> = {
  "runtime/local/src/client.ts": ["RpcClient.layerProtocolWorker", "BrowserWorker.layer"],
  "runtime/local/src/telemetry-otlp.ts": ["Resource.layer"],
  "runtime/local/src/worker-server.ts": [
    "localHandlersLayer",
    "localTelemetryLayer",
    "Layer.succeed",
    "RpcServer.layerProtocolWorkerRunner",
    "BrowserWorkerRunner.layer",
  ],
};

export const contractSuffixes: readonly string[] = [
  "Config",
  "Options",
  "Credentials",
  "Event",
  "Header",
  "Metadata",
  "Policy",
  "Request",
  "Response",
  "Result",
  "Document",
  "Input",
  "Data",
  "Appearance",
];
export const exportContractDeclarationPattern = new RegExp(
  `^\\s*export\\s+(?:interface|type)\\s+([A-Za-z_$][\\w$]*(?:${contractSuffixes.join("|")}))\\b`,
);
export const adapterOrPackagePathPrefixes: readonly string[] = ["core/", "runtime/"];
