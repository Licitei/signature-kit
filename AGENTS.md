# SignatureKit Agent Guidelines

SignatureKit is part of licitei-oss, maintained by Licitei. It is open-source, Effect-native infrastructure for digital-signature
runtimes. A1 / PKCS#12 is the first backend, not the product definition.

## Language and naming

- Code identifiers, file names, and public API names are English only.
- Keep APIs boring, typed, explicit, KISS. One clear Schema over clever wrappers.
- Prefer clear names such as `parseCertificate` and `localClientLayer`.

## Effect-native rules

- Public APIs return typed `Effect.Effect` values from `effect`.
- Recoverable technical faults stay in the typed Effect error channel.
- Mandatory invariants hard-fail with Effect defects or schema decode failures.
  Do not silently fall back for required configuration or impossible states.
- Use `Context.Service` + `Layer` (v4) for services and dependencies. Do not use
  `Context.Tag`, `Context.GenericTag`, `Effect.Tag`, or `Effect.Service`.
- Do not hide requirements with `Effect.provide` deep inside library code.
  `Effect.provide` is allowed in tests, application/runtime boundaries, and docs;
  package internals should expose requirements in the Effect environment.
- Timeout/retry policy uses `Duration` and `Schedule`. Retry must be classified.
- Secrets stay `Redacted` until the explicit serialization/import boundary.
- No `runSync` / `runPromise` / `runFork` / `Schema.decodeUnknownSync` in library internals.
- Effect-boundary escape comments use `[allow-run: <reason>]`,
  `[allow-provide: <reason>]`, or `[allow-string-secret: <reason>]`; the reason
  is required, and these directive comments are allowed only under
  `apps/docs/`. The library exceptions are the
  Promise entry points for apps without Effect (`promiseBoundaryModules` in
  `tooling/static-checks/src/config.ts`).
- Do not add explanatory comments to code. Keep only machine-required directive
  comments (`[allow-*]`, TypeScript references, generated-file pragmas).
- Use static imports for modules known at author time. Dynamic import is only for
  runtime-selected plugins, platform-specific modules, or test cases that
  explicitly exercise module loading.
- Stateful and global setup belongs in a service dependency.
- Never read ambient process state (`NODE_ENV`, env vars, globals) inside package
  internals to choose behavior. Decode explicit config through Schema or require a
  provided service/layer.
- Platform-specific capabilities are service requirements. Depend on portable
  `@effect/platform` services in library code and provide Node, Bun, or browser
  layers at assembly boundaries; direct platform imports belong in those layers,
  applications, or tests. Standard Web APIs are allowed only when they are part
  of the package's declared cross-runtime contract.
- HTTP cancellation covers fetch and response-body consumption as one lifecycle.
  Keep the abort handle scoped to that request, race body consumption with the
  same abort signal, clear listeners/timers on every completion path, and convert
  public millisecond inputs to `Duration` before scheduling the timeout.

## Error rules

- Errors are native Effect errors: branded `Schema.TaggedError` with a literal code
  catalog (`Schema.Literals([...])`) in the package `config.ts`.
- Construct the tagged error at the exact decision point.
- Do not create ad-hoc error/factory helpers like `makeProviderError`,
  `parseFailure`, `responseShapeFailure`, or any `*Error`/`*Failure`/`*Fault` name
  outside the `TaggedError` definition.
- Do not `throw` (no `throw new Error`, no re-throw), use library-level `try/catch/`
  `finally`, or build runtime error wrapper classes. Promise/IO adaptation uses
  `Effect.tryPromise` / `Effect.try` with an inline declarative `catch` that
  constructs a tagged error.
- Do not use `instanceof` for error/cause classification. At SDK boundaries,
  construct a tagged error with the exact operation, a stable human reason,
  known protocol facts (HTTP `status`, schema issue fields), and no generic
  unknown-cause metadata wrapper. If the cause has no real contract, let it be
  a defect instead of pretending it is typed.
- Do not add parallel internal error/result channels next to an existing
  `TaggedError`. Low-level parsers and decoders should return typed
  `Effect` failures directly; only total pure primitives may stay plain values.
- When a foreign SDK rejects with a documented structural error, validate that
  shape with `Schema.decodeUnknownEffect` before mapping it. If the rejected
  cause does not match a documented shape, let it remain a defect.
- Preserve structured origin metadata only when the source is typed or
  protocol-defined (`operation`, `phase`, `schemaName`, `issueMessage`, HTTP
  `status`, upstream tagged-error `_tag`/`code`). Do not use `String(error)` as
  the only data.
- Do not hand-roll schema-issue metadata extractors — a recursive
  `schemaIssueLeafMetadata` / `schemaErrorMetadata(error)` that walks a schema
  issue is exactly the wrapper to delete. Effect already formats decode failures:
  use `String(issue)` for human text, or `SchemaIssue.makeFormatterStandardSchemaV1`
  only when callers genuinely need structured Standard Schema issues. Keep only
  the typed fields you use (usually `schemaName` + `issueMessage`). A cause with
  no decoded contract is a defect, not metadata to launder.
- Schema decode failures are mapped where the schema is decoded. Do not add
  shared `decodeRemoteShape` / `decodeRemoteOptions`-style wrappers that hide the
  decision point; use inline `Schema.decodeUnknownEffect(...).pipe(Effect.mapError(...))`
  at the provider, resource, or public API boundary.
- Default error-message catalogs are source-of-truth data next to the
  `TaggedError`, backed by Schema-derived entry types. Apps resolve
  localized display copy by code from these catalogs.
- HTTP errors must never serialize secrets. If an upstream forces credentials into
  a URL query string, carry the real transport URL separately from a redacted
  diagnostic URL and use only the diagnostic URL in the tagged error reason.

## Schema and type rules

- Prefer `Schema` as the source of truth for data/config contracts; derive types.
- Use `Schema.Literals([...])` for literal catalogs (codes, statuses, operations,
  hash algorithms). Hash/algorithm catalogs stay in the owning package, and total
  maps use `Match.exhaustive` instead of hand unions or ternary chains.
- Use top-level `import type` declarations for type-only dependencies; do not
  hide package dependencies inside inline type annotations.
- No `as` casts, including `as const`. Validate/convert through Schema/Effect, keep
  literal catalogs in `Schema.Literals([...])`, or model data as discriminated
  unions so reads narrow without assertions.
- No manual interfaces for config/data contracts when `Schema` can derive the type.
- If public docs need an example value for a Schema-backed contract, make the
  snippet use the actual public contract shape.
- Pure functions that accept a Schema-derived type do not secretly decode it
  again. Decode untrusted values explicitly at the caller boundary.

## Effect 4 idioms

- Wrap an external library/SDK or stateful runtime as a `Context.Service` that
  exposes typed `Effect` methods plus a `raw` escape hatch only when the SDK has a
  useful underlying client contract. Construct it via `Layer`; keep secrets
  `Redacted` and unwrap only at the SDK call.
- Adapt SDK promises with `Effect.tryPromise`; in `catch`, construct the tagged
  error directly with explicit operation/reason/status metadata. Do not add error
  wrapper helpers, `safeCauseMetadata`/`toCauseMetadata`, or `instanceof` branches.
  Push typing down to the wrapper so consumers only ever see tagged errors.
- Effect 4 renamed `Either` → `Result`: use `Effect.result` + `Result.isSuccess/`
  `isFailure`, not `Effect.either` / `effect/Either` (removed).
- Use `Effect.fn(function* (args) { ... })` for service and provider methods so
  argument inference is preserved. Reserve `Effect.fnUntraced` for deliberately
  untraced leaf helpers, not lifecycle methods.
- Do not wrap pure hooks in generator functions. If a provider hook only returns
  `Effect.succeed(...)`, write a plain function; reserve `Effect.fn(function* ...)`
  for bodies that actually `yield*`.
- Use `Match.value(x).pipe(Match.when(...), Match.exhaustive)` for total
  branching, especially Schema-backed algorithm/status maps.
- Use `Effect.forEach` directly for bounded in-memory batches; it is sequential by
  default. Add `{ concurrency }` when calls are independent, preserve order only
  when the upstream protocol requires it, and add `discard: true` when the result
  array is intentionally unused.
- Use `Stream` for paginated or unbounded sequences (`Stream.paginate` +
  `Stream.runCollect` for provider list endpoints). Use `Sink` when a stream
  should be folded, counted, validated, or written without retaining every item.
- Use `Cache` for overlapping expensive lookups and Effect batching (`Request` /
  `Resolver`) for N+1 service/API reads. Keep both behind a service/layer seam;
  do not hand-roll mutable maps at call sites. A small per-adapter closure cache is
  acceptable only when the adapter constructor must remain pure and introducing a
  layer would force `runSync`.
- Use `Ref` only for cross-fiber mutable state owned by a service/layer. Pure
  builder/config data stays immutable values.
- Long-lived resources live in `Layer.scoped` with `Effect.acquireRelease`;
  short critical cleanup uses `Effect.ensuring`/`onExit`.

## Keep ownership small

- Prefer native contracts and lifecycles. An abstraction must own domain policy,
  boundary validation, resource lifetime, or demonstrated reuse. Forwarding,
  renaming, adding a span, or keeping a caller short does not justify a layer.
- Trace current owners and consumers before removing code. Include public package
  exports, docs, tests, registry copies, and executable configuration; an external
  API contract is a consumer even when this workspace does not call it.
- Remove obsolete callers, exports, dependencies, aliases, and configuration in
  the same cutover. Preserve behavior-bearing tests; do not optimize deletion counts.
- Optional modes, empty catalogs, and extension points require a current consumer
  or an explicit public contract. Do not retain scaffolding for hypothetical use.
- Rules describe invariants once. Exact commands, versions, schemas, and package
  inventories belong to executable owners. Prefer native lint/parser facilities
  over handwritten lexers or name-based bans; test aliases, shadowing, multiline
  syntax, template expressions, and actual file selection.

## SignatureKit 2.0

The local browser runtime comes first, followed by the server runtime. External
providers are rebuilt last on 2.0 contracts. See [the architecture](docs/v2/ARCHITECTURE.md).

## Layers

- `crates/pdf` owns Rust PDF operations and fixtures. `crates/wasm` owns the C
  ABI and assembles the enabled Rust engines into `signature-kit.wasm`.
- `packages/engine` owns the RPC contract, document revisions, A1 sessions,
  telemetry, codecs, and WASM bindings. Private signing keys stay inside the
  worker as non-extractable WebCrypto keys.
- `packages/browser` owns the Web Worker, client, and viewer. The worker uses
  public engine subpaths. Page-side client modules import the engine RPC
  contract. The engine has no browser package dependency.
- Package exports point at real modules in `dist/`, built by `tsc`. Keep
  workspace dependencies, TypeScript references, and source aliases aligned.
  Imports used exclusively in tests belong in `devDependencies`.
- Keep tests with their behavior. Docs assemble public capabilities using
  Foldkit and the app's existing UI primitives.

## Packages

| Directory | npm package | Responsibility |
| --- | --- | --- |
| `packages/engine` | `@signature-kit/engine` | RPC contract, engine services, codecs and WASM bindings |
| `packages/browser` | `@signature-kit/browser` | Browser worker, client, viewer and OTLP export |

## Validation

- For non-trivial changes run `bun run build && bun run check && bun run test` at
  the repo root. `build` is required first because package exports point at
  `dist/` entrypoints generated by `tsc`; CI builds before tests and `dist/` stays
  gitignored.
- Prefer structural and static checks over ad-hoc review:
  - `bun run check:konsistent` validates `konsistent.json` and enforces
    structural conventions: source dependency-direction imports, no barrel-only
    source modules, required package files, and source-level dependency boundaries.
  - `bun run check:declarative-errors` owns content-level bans and manifest/
    workspace checks that `konsistent` cannot express.
  - no `runSync`/`runPromise`/`runFork` in library internals
  - no `as` casts (`as Foo`/`as any`/`as unknown as`/`as const`)
  - no inline import-type annotations or unnecessary dynamic imports
  - no `throw`, `instanceof`, or library `try/catch`
  - no legacy Effect service APIs
  - no manual config/data contracts when `Schema` can derive the type
  - no ambient `NODE_ENV` behavior selection
  - no stale `dist/` files or export/path alias drift
  - secrets use `Redacted`
- Tests for Effect workflows use `@effect/vitest` or Bun. Use a scoped local
  HTTP server for network behavior.
- For PDF changes run the relevant Rust and `packages/engine` suites
  and `bun run test:integration:browser`. Run `bun run test:performance` when
  changing hot paths. Use independent readers to check PDF interoperability.

## Test and release contracts

- Test observable behavior with real implementations. New or rewritten tests use
  scoped resources and local HTTP servers instead of module mocks, spies, patched
  globals, or handwritten SDK doubles. Retain existing failure cases when replacing
  a harness; existing violations are debt, not precedent.
- Use Effect TestClock for Effect scheduling and native browser behavior for browser
  lifecycles. Acquisition failure, assertion failure, and interruption must release
  resources. Do not share mutable test resources across test cases.
- Suite discovery includes all tests in its owning directories. Never enumerate
  individual browser files in release/CI commands. Local suites must not activate
  live provider writes from ambient developer configuration; live suites have
  explicit commands and fail when required credentials are missing.
- Verify cancellation, cleanup, malformed input, isolation, and real pagination
  boundaries where relevant. Static gates assert architecture; behavior tests do
  not substitute source spelling or copied constants for execution.
- Release validation includes package build, static/type checks, local tests,
  browser integration, performance checks, site build, and package packing.
  Report local, CI, and publication evidence separately.
- Preserve the repository's Tegami release owner and npm trusted publishing.
  Prepare a changelog, run `bun run release version`, and commit the generated
  versions, changelog, and publish lock for CI review before publication;
  a Git push or successful dry-run is not evidence of an npm release.

## Effect-aware linting

- Oxlint owns Effect diagnostics through the official `@effect/tsgo` integration.
  Keep `@effect/tsgo`, `oxlint`, and `oxlint-tsgolint` pinned to the upstream
  compatibility matrix. The root `prepare` patches Oxlint only; TypeScript 7's `tsc` owns
  package declaration builds and type checks. The `typescript` npm alias provides
  Microsoft's TypeScript 6 compatibility API to Nx and AST-based tooling.
- Use the native correctness preset and the selected simplification rules in
  `tooling/oxc/base.json`; docs inherit them. Warnings fail the lint gate.
  Prefer native combinators over equivalent scaffolding. `Effect.void` has a
  void success channel in the installed Effect version; preserve
  `Effect.succeed(undefined)` when an optional-value contract requires undefined.
  Do not enable `effect-succeed-with-void` until it respects that distinction. Do not duplicate those diagnostics in custom checks.
- Integration tests execute the installed patched Oxlint on real TypeScript
  programs and assert both rejection and acceptance. A config entry alone does
  not prove that type-aware analysis or the binary patch is active.

## Done means

- `bun run build && bun run check && bun run test` was actually run and reported.
- Library internals remain substitutable via services/layers.
- Error conversion preserves enough structured context for debugging.
- No claim of "Effect-native" while throws, `as` casts, hidden `provide`, inline
  type imports, unnecessary dynamic imports, or erased error origins remain.
