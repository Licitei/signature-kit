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

export const packageToolingPathPattern = /(?:^|\/)packages\/[^/]+\/(?:scripts|bench)\//;

export const roots = ["packages"];

export const promiseBoundaryModules: readonly string[] = [
  "packages/engine/src/wasm/promise.ts",
  "packages/engine/src/wasm/node.ts",
];

export const nodeBoundaryModules: readonly string[] = ["packages/engine/src/wasm/node.ts"];

export const allowedRuntimeImports: Record<string, readonly string[]> = {
  "packages/engine/src/wasm/compose.ts": ["./compose-fonts.mjs"],
};

export const allowedEffectProvideSites: Record<string, readonly string[]> = {
  "packages/browser/src/client.ts": ["RpcClient.layerProtocolWorker", "BrowserWorker.layer"],
  "packages/browser/src/signing-pool.ts": ["RpcClient.layerProtocolWorker", "BrowserWorker.layer"],
  "packages/browser/src/telemetry-otlp.ts": ["Resource.layer"],
  "packages/browser/src/worker-server.ts": ["pdfVerificationLayer", "composeBrowserLayer"],
  "packages/browser/src/signing-worker-server.ts": [
    "BrowserKeyValueStore.layerIndexedDb",
    "indexedDbWorkerLayer",
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
export const adapterOrPackagePathPrefixes: readonly string[] = ["packages/"];
