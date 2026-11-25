const context = navigator.modelContext;

const text = (value) => ({ content: [{ type: "text", text: value }] });

const readText = async (path) => {
  const response = await fetch(path, { headers: { Accept: "text/markdown" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}`);
  return response.text();
};

const docPath = (page) => {
  const clean = String(page ?? "")
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/\.md$/, "")
    .replace(/^\/+/, "");
  if (clean === "" || clean === "docs") return "/docs.md";
  return clean.startsWith("docs/") ? `/${clean}.md` : `/docs/${clean}.md`;
};

const tools = [
  {
    name: "buscar_documentacao",
    description:
      "Busca na documentação do SignatureKit (assinatura digital A1, PDF/PAdES, XML-DSig, provedores Clicksign, Assinafy, ZapSign, DocuSeal, Documenso). Retorna títulos, trechos e a URL em Markdown de cada resultado.",
    inputSchema: {
      type: "object",
      properties: { consulta: { type: "string", description: "Termos de busca em português." } },
      required: ["consulta"],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ consulta }) => {
      const response = await fetch(`/api/search.json?q=${encodeURIComponent(consulta)}`);
      const results = await response.json();
      return text(
        results.length === 0
          ? "Nenhum resultado."
          : results
              .slice(0, 8)
              .map((result) => `- ${result.title}${result.heading !== "" ? ` — ${result.heading}` : ""}: ${result.excerpt}\n  ${result.markdown}`)
              .join("\n"),
      );
    },
  },
  {
    name: "ler_pagina",
    description:
      "Lê uma página da documentação do SignatureKit em Markdown. Aceita o caminho (ex.: get-started/quickstart, providers/clicksign) ou a URL completa.",
    inputSchema: {
      type: "object",
      properties: { pagina: { type: "string", description: "Caminho ou URL da página." } },
      required: ["pagina"],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ pagina }) => text(await readText(docPath(pagina))),
  },
  {
    name: "listar_paginas",
    description: "Lista todas as páginas da documentação do SignatureKit, agrupadas por seção, com descrição e URL em Markdown.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => text(await readText("/llms.txt")),
  },
  {
    name: "pagina_atual",
    description: "Retorna em Markdown a página da documentação que o usuário está vendo agora.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () =>
      location.pathname.startsWith("/docs")
        ? text(await readText(docPath(location.pathname)))
        : text(`O usuário está em ${location.pathname}, que não é uma página da documentação.`),
  },
  {
    name: "abrir_assinador",
    description:
      "Abre o assinador de PDF grátis do SignatureKit nesta aba. O usuário escolhe o PDF, o certificado A1 e a senha; nada é enviado para servidor.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      location.assign("/assine-documentos-gratis");
      return text("Assinador aberto. Peça ao usuário para soltar o PDF e escolher o certificado A1.");
    },
  },
];

if (context !== undefined) {
  if (typeof context.registerTool === "function") for (const tool of tools) context.registerTool(tool);
  else if (typeof context.provideContext === "function") context.provideContext({ tools });
}
