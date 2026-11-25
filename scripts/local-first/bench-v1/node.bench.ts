import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { it } from "vitest";
import { pdfCoreTestLayer } from "../../../formats/pdf/__tests__/pdf-core-layer";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { Effect } from "effect";
import { output, root } from "./config";
import { pdfFixtures } from "./corpus";
import { makeRecorder } from "./measure";
import { runOperations } from "./operations";

it("records SignatureKit v1 operations in Node", async () => {
  const { record, cases } = makeRecorder("node", "process.memoryUsage()", () => {
    const { rss, heapUsed, arrayBuffers } = process.memoryUsage();
    return { rss, heapUsed, arrayBuffers };
  });
  const pdfs = Object.fromEntries(
    await Promise.all(
      Object.entries(pdfFixtures).map(async ([name, path]) => [
        name,
        new Uint8Array(await readFile(resolve(root, path))),
      ]),
    ),
  );
  const { copies, cores, signedXml } = await runOperations(
    record,
    pdfCoreTestLayer,
    {
      ecpf: await Effect.runPromise(readA1Fixture("ecpf")),
      ecnpj: await Effect.runPromise(readA1Fixture("ecnpj")),
    },
    pdfs,
  );
  const large = cores.find(({ corpus }) => corpus === "synthetic-21mib");
  if (large !== undefined) {
    await mkdir(resolve(output, "corpus"), { recursive: true });
    await writeFile(resolve(output, "corpus/0020p_synthetic-21mib.pdf"), large.pdf);
  }
  for (const [id, xml] of Object.entries(signedXml)) {
    await writeFile(resolve(output, "corpus", id + ".xml"), xml);
  }
  await writeFile(
    resolve(output, "node.json"),
    JSON.stringify(
      {
        engine: process.version,
        cases,
        copies,
      },
      null,
      2,
    ) + "\n",
  );
}, 300_000);
