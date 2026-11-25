import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { contentTargetsFor } from "./content";
import { prerenderPaths, renderDocument, renderPage } from "./entry.server";
import { llmsTxt } from "./agents";
import { pdfCoreDescription, pdfCorePath } from "./pdf-core-page";
import { xmlPreview } from "./tool-client";
import { toolPages } from "./tool-pages";
import { Message, toolsInit, toolsUpdate } from "./tool-view";

const assets = { entryScript: "/entry.js", stylesheets: [], modulePreloads: [] };
const render = async (path: string) => {
  const result = await renderPage(new Request(`https://signaturekit.dev${path}`), "test");
  if (result._tag !== "Rendered") return expect.fail(`Missing ${path}`);
  return renderDocument(result.application, assets);
};
const structuredData = (html: string): unknown => {
  const match = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html);
  if (match?.[1] === undefined) return expect.fail("Missing JSON-LD");
  return JSON.parse(match[1]);
};

describe("tool pages", () => {
  it("prerenders every tool page with metadata, steps, FAQ and structured data", async () => {
    expect(toolPages.map((page) => page.path)).toEqual([
      "assine-documentos-gratis",
      "assinar-pdf-em-lote",
      "rubricar-pdf",
      "verificar-assinatura-pdf",
      "ler-certificado-pfx",
      "assinar-xml-com-certificado-a1",
    ]);
    for (const page of toolPages) {
      const path = `/${page.path}`;
      expect(prerenderPaths).toContain(path);
      expect(page.description.length).toBeLessThanOrEqual(155);
      expect(`${page.title} | SignatureKit`.length).toBeLessThanOrEqual(70);
      const html = await render(path);
      expect(html).toContain(`<title>${page.title} | SignatureKit</title>`);
      expect(html).toContain(`rel="canonical" href="https://signaturekit.dev${path}"`);
      expect(html).toContain(`name="description" content="${page.description}"`);
      expect(html).toContain(`property="og:image" content="https://signaturekit.dev${path}.webp"`);
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain(page.heading);
      for (const step of page.steps) expect(html).toContain(step.title);
      for (const item of page.faqs) expect(html).toContain(item.question);
      for (const link of page.related) expect(html).toContain(`href="${link.href}"`);
      expect(structuredData(html)).toMatchObject({
        "@graph": [
          { "@type": "SoftwareApplication", url: `https://signaturekit.dev${path}` },
          { "@type": "HowTo", step: page.steps.map((step) => ({ name: step.title })) },
          { "@type": "FAQPage", mainEntity: page.faqs.map((item) => ({ name: item.question })) },
        ],
      });
      const image = await renderPage(new Request(`https://signaturekit.dev${path}.webp`), "test");
      expect(image._tag).toBe("Responded");
    }
  });

  it("links related articles and tools that exist", async () => {
    const internal = new Set(
      toolPages.flatMap((page) => [
        page.aside.link.href,
        page.faqLink.href,
        ...page.related.map((link) => link.href),
      ]),
    );
    for (const href of internal) {
      if (!href.startsWith("/")) continue;
      expect(prerenderPaths, href).toContain(href);
    }
  });

  it("renders each tool widget and keeps honest limits in the copy", async () => {
    const verify = await render("/verificar-assinatura-pdf");
    expect(verify).toContain('data-tool="verify"');
    expect(verify).toContain("https://validar.iti.gov.br");
    expect(verify).toContain("não valida a cadeia da ICP-Brasil");
    const certificate = await render("/ler-certificado-pfx");
    expect(certificate).toContain('data-tool="certificate"');
    expect(certificate).toContain('id="tool-certificate-password"');
    const xml = await render("/assinar-xml-com-certificado-a1");
    expect(xml).toContain('data-tool="xml"');
    expect(xml).toContain("não garante conformidade com esses layouts");
    const rubric = await render("/rubricar-pdf");
    expect(rubric).toContain('data-signing-mode="completa"');
    expect(rubric).toMatch(
      /data-rubric=""[^>]*aria-checked="true"|aria-checked="true"[^>]*data-rubric=""/,
    );
    const batch = await render("/assinar-pdf-em-lote");
    expect(batch).toContain('data-signing-mode="rapida"');
  });

  it("publishes the pdf-core showcase with source-code structured data", async () => {
    expect(prerenderPaths).toContain(pdfCorePath);
    expect(pdfCoreDescription.length).toBeLessThanOrEqual(155);
    const html = await render(pdfCorePath);
    expect(html).toContain('data-tool="pdfcore"');
    expect(html).toContain("2,42");
    expect(html).toContain("LiteParse 2.20.0");
    expect(html).toContain("@signature-kit/pdf-core/promise");
    expect(structuredData(html)).toMatchObject({
      "@type": "SoftwareSourceCode",
      url: "https://signaturekit.dev/pdf-core",
      programmingLanguage: ["Rust", "TypeScript", "WebAssembly"],
    });
    const home = await render("/");
    expect(home).toContain('href="/pdf-core"');
  });

  it("lists the tools for agents", () => {
    const text = llmsTxt();
    for (const page of toolPages) expect(text).toContain(`https://signaturekit.dev/${page.path}`);
    expect(text).toContain("https://signaturekit.dev/pdf-core");
  });
});

describe("content targets", () => {
  it("selects only the content a route needs before hydration", () => {
    expect(contentTargetsFor("/")).toEqual([]);
    expect(contentTargetsFor("/verificar-assinatura-pdf")).toEqual([]);
    expect(contentTargetsFor("/search")).toEqual(["docs"]);
    expect(contentTargetsFor("/blog")).toEqual(["blog"]);
    expect(contentTargetsFor("/changelog/")).toEqual(["changelog"]);
    expect(contentTargetsFor("/blog/tags/icp-brasil")).toEqual([]);
    expect(contentTargetsFor("/docs")).toEqual(["../content/docs/index.mdx"]);
    expect(contentTargetsFor("/docs/get-started/quickstart")).toEqual([
      "../content/docs/get-started/quickstart.mdx",
    ]);
    expect(contentTargetsFor("/blog/certificado-a1-ou-a3")).toEqual([
      "../content/blog/certificado-a1-ou-a3.mdx",
    ]);
  });
});

describe("tool state", () => {
  const file = (name: string) => new File([new Uint8Array([1])], name);
  const dropped = (target: "verify" | "certificate" | "xml" | "xmlPfx" | "pdfcore", name: string) =>
    Message.GotDropMessage({
      targetId: target,
      message: { _tag: "DroppedFiles", files: [file(name)] },
    });

  it("starts verification when a PDF is dropped and ignores stale results", () => {
    const first = toolsUpdate(toolsInit(), dropped("verify", "a.pdf"));
    expect(first.model.verify._tag).toBe("Working");
    expect(Option.getOrNull(first.model.verifyFile)).toBe("a.pdf");
    expect(first.commands?.map((command) => command.name)).toContain("VerifyPdf");
    const second = toolsUpdate(first.model, dropped("verify", "b.pdf"));
    const stale = toolsUpdate(
      second.model,
      Message.ToolFailed({ tool: "verify", run: first.model.run, message: "antigo" }),
    );
    expect(stale.model.verify._tag).toBe("Working");
    const done = toolsUpdate(
      second.model,
      Message.PdfVerified({ run: second.model.run, reports: [] }),
    );
    expect(done.model.verify._tag).toBe("Verified");
  });

  it("asks for the missing inputs before reading a certificate or signing XML", () => {
    const empty = toolsUpdate(toolsInit(), Message.CertificateSubmitted());
    expect(empty.model.certificate).toMatchObject({ _tag: "Failed" });
    expect(empty.commands ?? []).toHaveLength(0);
    const chosen = toolsUpdate(toolsInit(), dropped("certificate", "a.pfx"));
    const reading = toolsUpdate(chosen.model, Message.CertificateSubmitted());
    expect(reading.model.certificate._tag).toBe("Working");
    expect(reading.commands?.map((command) => command.name)).toEqual(["ReadCertificate"]);
    const noXml = toolsUpdate(toolsInit(), Message.XmlSubmitted());
    expect(noXml.model.xml).toMatchObject({ _tag: "Failed", message: "Escolha o arquivo XML." });
    const withXml = toolsUpdate(toolsInit(), dropped("xml", "a.xml"));
    const noPfx = toolsUpdate(withXml.model, Message.XmlSubmitted());
    expect(noPfx.model.xml).toMatchObject({ _tag: "Failed" });
    const withBoth = toolsUpdate(withXml.model, dropped("xmlPfx", "a.pfx"));
    const signing = toolsUpdate(withBoth.model, Message.XmlSubmitted());
    expect(signing.commands?.map((command) => command.name)).toEqual(["SignXml"]);
  });
});

describe("xml preview", () => {
  it("marks only the signature lines as added and keeps context", () => {
    const lines = xmlPreview(
      '<a Id="x"><b>texto</b><ds:Signature xmlns:ds="urn:x"><ds:SignedInfo><ds:DigestValue>abc</ds:DigestValue></ds:SignedInfo></ds:Signature></a>',
    );
    expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
    expect(lines.map(({ added, text }) => ({ added, text }))).toEqual([
      { added: false, text: '<a Id="x">' },
      { added: false, text: "  <b>texto</b>" },
      { added: true, text: '  <ds:Signature xmlns:ds="urn:x">' },
      { added: true, text: "    <ds:SignedInfo>" },
      { added: true, text: "      <ds:DigestValue>abc</ds:DigestValue>" },
      { added: true, text: "    </ds:SignedInfo>" },
      { added: true, text: "  </ds:Signature>" },
      { added: false, text: "</a>" },
    ]);
  });
});
