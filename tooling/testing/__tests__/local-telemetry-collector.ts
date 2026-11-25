import { createServer } from "node:http";
import { Effect, Exit, Scope } from "effect";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    localTelemetryCollectorOrigin: string;
  }
}

export default async function setup(project: TestProject) {
  const scope = await Effect.runPromise(Scope.make());
  const collector = Effect.gen(function* () {
    const payloads = new Map<string, string>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          const path = request.url;
          if (path !== "/telemetry-test" && path !== "/telemetry-bench") {
            response.writeHead(404).end();
            return;
          }
          response.setHeader("access-control-allow-origin", "*");
          response.setHeader("access-control-allow-headers", "content-type");
          if (request.method === "OPTIONS") {
            response.writeHead(204).end();
          } else if (request.method === "GET") {
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(payloads.get(path) ?? "null");
          } else if (request.method === "POST") {
            request.setEncoding("utf8");
            let payload = "";
            request.on("data", (chunk: string) => {
              payload += chunk;
              if (payload.length > 4 * 1024 * 1024) request.destroy();
            });
            request.on("end", () => {
              payloads.set(path, payload);
              response.writeHead(200, { "content-type": "application/json" }).end("{}");
            });
          } else {
            response.writeHead(405).end();
          }
        }),
      ),
      (server) =>
        Effect.promise(() => {
          server.closeAllConnections();
          return new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );
    const port = yield* Effect.callback<number>((resume) => {
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          address !== null && typeof address !== "string"
            ? Effect.succeed(address.port)
            : Effect.die("The telemetry collector did not bind a TCP port."),
        );
      });
    });
    project.provide("localTelemetryCollectorOrigin", `http://127.0.0.1:${port}`);
  });
  await Effect.runPromise(
    collector.pipe(
      Scope.provide(scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    ),
  );
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}
