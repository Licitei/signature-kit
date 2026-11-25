import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localHttpServer } from "./local-http.js";
import type { LocalResponse } from "./local-http.js";

const run = promisify(execFile);
const unauthorized = new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x06]);
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "accept, content-type",
};

export const validationFixture = (name: string) =>
  Effect.promise(
    async () =>
      new Uint8Array(await readFile(new URL(`./fixtures/validation/${name}`, import.meta.url))),
  );

export const localEvidenceServers = Effect.gen(function* () {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "signature-kit-evidence-"))),
    (path) => Effect.promise(() => rm(path, { force: true, recursive: true })),
  );
  const [good, tsaGood, crl] = yield* Effect.all([
    validationFixture("good.der"),
    validationFixture("tsa-good.der"),
    validationFixture("revoked-crl.der"),
  ]);
  const p12 = new URL("./fixtures/validation/tsa.p12", import.meta.url).pathname;
  const ca = new URL("./fixtures/validation/ca.der", import.meta.url).pathname;
  const tsaDer = new URL("./fixtures/validation/tsa.der", import.meta.url).pathname;
  yield* Effect.promise(async () => {
    await run("openssl", [
      "pkcs12",
      "-in",
      p12,
      "-passin",
      "pass:changeit",
      "-nocerts",
      "-nodes",
      "-out",
      join(dir, "tsa.key"),
    ]);
    await run("openssl", ["x509", "-inform", "DER", "-in", tsaDer, "-out", join(dir, "tsa.pem")]);
    await run("openssl", ["x509", "-inform", "DER", "-in", ca, "-out", join(dir, "ca.pem")]);
    await writeFile(join(dir, "tsa.serial"), "01\n");
    await writeFile(
      join(dir, "tsa.cnf"),
      [
        "[tsa]",
        "default_tsa=local",
        "[local]",
        `serial=${join(dir, "tsa.serial")}`,
        `signer_cert=${join(dir, "tsa.pem")}`,
        `certs=${join(dir, "ca.pem")}`,
        `signer_key=${join(dir, "tsa.key")}`,
        "signer_digest=sha256",
        "default_policy=1.3.6.1.4.1.12345.1",
        "digests=sha256,sha384,sha512",
        "ess_cert_id_alg=sha256",
        "",
      ].join("\n"),
    );
  });
  const serial = (file: string) =>
    run("openssl", ["x509", "-inform", "DER", "-in", file, "-noout", "-serial"]).then(
      ({ stdout }) => stdout.trim().replace(/^serial=/, ""),
    );
  const signerDer = new URL("./fixtures/validation/signer.der", import.meta.url).pathname;
  const serials = yield* Effect.promise(async () => [
    { serial: await serial(signerDer), response: good },
    { serial: await serial(tsaDer), response: tsaGood },
  ]);
  let sequence = 0;
  const server = yield* localHttpServer(async (request): Promise<LocalResponse> => {
    if (request.method === "OPTIONS")
      return {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-headers":
            request.headers["access-control-request-headers"] ??
            cors["access-control-allow-headers"],
        },
      };
    if (request.method === "GET" && request.pathname === "/crl") {
      return {
        status: 200,
        headers: { ...cors, "content-type": "application/pkix-crl" },
        body: crl,
      };
    }
    if (request.method === "POST" && request.pathname === "/ocsp") {
      sequence += 1;
      const query = join(dir, `ocsp-${sequence}.der`);
      await writeFile(query, request.bodyBytes);
      const { stdout } = await run("openssl", ["ocsp", "-reqin", query, "-req_text"]);
      const requested = /Serial Number:\s*([0-9A-Fa-f]+)/.exec(stdout)?.[1]?.toUpperCase();
      const match = serials.find((entry) => entry.serial.toUpperCase() === requested);
      return {
        status: 200,
        headers: { ...cors, "content-type": "application/ocsp-response" },
        body: match?.response ?? unauthorized,
      };
    }
    if (request.method === "POST" && request.pathname === "/tsa") {
      sequence += 1;
      const query = join(dir, `query-${sequence}.der`);
      const reply = join(dir, `reply-${sequence}.der`);
      await writeFile(query, request.bodyBytes);
      await run("openssl", [
        "ts",
        "-reply",
        "-config",
        join(dir, "tsa.cnf"),
        "-queryfile",
        query,
        "-out",
        reply,
      ]);
      return {
        status: 200,
        headers: { ...cors, "content-type": "application/timestamp-reply" },
        body: new Uint8Array(await readFile(reply)),
      };
    }
    return { status: 404, headers: cors };
  });
  return {
    ocspUrl: `${server.baseUrl}/ocsp`,
    crlUrl: `${server.baseUrl}/crl`,
    tsaUrl: `${server.baseUrl}/tsa`,
    requests: server.requests,
  };
});
