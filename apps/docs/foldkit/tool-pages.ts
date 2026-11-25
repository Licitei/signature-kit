import { Disclosure } from "@foldkit/ui";
import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { pageRoute } from "./routes";
import { landing } from "./styles/landing";
import { pages } from "./styles/pages";
import { sx } from "./styles/sx";
import type { ToolId } from "./tool-config";

export const FaqIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export type ToolPageLink = {
  readonly label: string;
  readonly hint: string;
  readonly href: string;
  readonly kind?: string;
};

export type ToolPage = {
  readonly path: string;
  readonly kind: "signer" | ToolId;
  readonly preset?: "lote" | "rubrica";
  readonly anchor: string;
  readonly tone: "dark" | "light";
  readonly title: string;
  readonly description: string;
  readonly social: string;
  readonly nav: { readonly label: string; readonly hint: string; readonly glyph: IconName };
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly facts: ReadonlyArray<{ readonly glyph: IconName; readonly text: string }>;
  readonly stepsTitle: string;
  readonly stepsLead: string;
  readonly steps: ReadonlyArray<{ readonly title: string; readonly body: string }>;
  readonly outcomesTitle: string;
  readonly outcomes: ReadonlyArray<{ readonly title: string; readonly body: string }>;
  readonly aside: {
    readonly title: string;
    readonly lead: string;
    readonly link: { readonly label: string; readonly href: string };
    readonly items: ReadonlyArray<{
      readonly title: string;
      readonly body: string;
      readonly current: boolean;
    }>;
  };
  readonly faqLead: string;
  readonly faqLink: { readonly label: string; readonly href: string };
  readonly faqs: ReadonlyArray<{ readonly question: string; readonly answer: string }>;
  readonly related: ReadonlyArray<ToolPageLink>;
  readonly app: { readonly name: string; readonly howTo: string; readonly totalTime: string };
};

const blog = {
  a1a3: {
    label: "Certificado A1 ou A3: qual escolher",
    hint: "Onde a chave fica, validade e quando cada tipo faz sentido.",
    href: pageRoute({ path: "blog/certificado-a1-ou-a3" }),
  },
  niveis: {
    label: "Assinatura simples, avançada e qualificada",
    hint: "O que a Lei 14.063/2020 diz sobre cada nível.",
    href: pageRoute({ path: "blog/assinatura-simples-avancada-qualificada" }),
  },
  validar: {
    label: "Como validar uma assinatura no Validar do ITI",
    hint: "Passo a passo no verificador oficial e como ler o relatório.",
    href: pageRoute({ path: "blog/como-validar-assinatura-digital-no-validar-iti" }),
  },
  xml: {
    label: "Como funciona a assinatura de XML",
    hint: "Referência, canonicalização e resumo no XML-DSig.",
    href: pageRoute({ path: "blog/como-funciona-assinatura-xml-dsig" }),
  },
} satisfies Record<string, ToolPageLink>;

const docs = {
  browser: {
    label: "Assinatura A1 no navegador",
    hint: "Como o fluxo desta página funciona por dentro.",
    href: pageRoute({ path: "docs/a1-signing/browser-pdf-flow" }),
  },
  pdf: {
    label: "Referência de PDF e PAdES",
    hint: "Assinar, carimbar e verificar PDFs pela biblioteca.",
    href: pageRoute({ path: "docs/signing/pdf" }),
  },
  xml: {
    label: "Referência de XML-DSig",
    hint: "signXml e verifyXml no seu sistema.",
    href: pageRoute({ path: "docs/signing/xml" }),
  },
  certificates: {
    label: "Referência de certificados",
    hint: "Leia PKCS#12 e X.509 pela biblioteca.",
    href: pageRoute({ path: "docs/signing/certificates" }),
  },
} satisfies Record<string, ToolPageLink>;

const tool = {
  sign: {
    label: "Assinar PDF grátis",
    hint: "Assinatura PAdES com certificado A1, no navegador.",
    href: pageRoute({ path: "assine-documentos-gratis" }),
  },
  batch: {
    label: "Assinar PDF em lote",
    hint: "Até 100 PDFs com o mesmo certificado.",
    href: pageRoute({ path: "assinar-pdf-em-lote" }),
  },
  rubric: {
    label: "Rubricar PDF",
    hint: "Rubrica em cada página e assinatura digital.",
    href: pageRoute({ path: "rubricar-pdf" }),
  },
  verify: {
    label: "Verificar assinatura de PDF",
    hint: "Veja quem assinou e se o arquivo mudou.",
    href: pageRoute({ path: "verificar-assinatura-pdf" }),
  },
  certificate: {
    label: "Ler certificado A1",
    hint: "Titular, CPF ou CNPJ, emissor e validade.",
    href: pageRoute({ path: "ler-certificado-pfx" }),
  },
  xml: {
    label: "Assinar XML",
    hint: "XML-DSig enveloped com certificado A1.",
    href: pageRoute({ path: "assinar-xml-com-certificado-a1" }),
  },
} satisfies Record<string, ToolPageLink>;

const legalAside = {
  title: "Validade jurídica",
  lead: "A Lei 14.063/2020 define três níveis de assinatura eletrônica. Com certificado ICP-Brasil, a sua é qualificada, o nível com presunção de validade jurídica dada pela MP 2.200-2/2001.",
  link: { label: "Validar a assinatura no ITI →", href: "https://validar.iti.gov.br" },
  items: [
    {
      title: "Simples",
      body: "Identifica o signatário por meios simples, como e-mail ou código por SMS.",
      current: false,
    },
    {
      title: "Avançada",
      body: "Associa a assinatura ao signatário de forma unívoca, como a assinatura gov.br.",
      current: false,
    },
    {
      title: "Qualificada",
      body: "Usa certificado digital ICP-Brasil, como o seu A1. É o nível gerado por esta página.",
      current: true,
    },
  ],
};

const signerFaqs = {
  legal: {
    question: "A assinatura tem validade jurídica?",
    answer:
      "Sim. Com certificado ICP-Brasil, a assinatura é qualificada, o nível mais alto da Lei 14.063/2020, e tem presunção de validade jurídica pela MP 2.200-2/2001.",
  },
  signup: {
    question: "Precisa de cadastro?",
    answer: "Não. Basta o PDF, o arquivo do certificado A1 (.pfx ou .p12) e a senha.",
  },
  server: {
    question: "O documento vai para algum servidor?",
    answer:
      "Não. O PDF, o certificado e a senha ficam na memória do seu navegador durante a assinatura e não são enviados a nenhum servidor.",
  },
  check: {
    question: "Como confiro se a assinatura é válida?",
    answer:
      "Envie o PDF assinado ao Validar, verificador oficial do ITI (validar.iti.gov.br), ou abra o arquivo no Adobe Acrobat Reader e confira o painel de assinaturas.",
  },
  a3: {
    question: "Funciona com certificado A3 (token, cartão ou nuvem)?",
    answer:
      "Não. Esta página assina apenas com certificado A1, o arquivo .pfx ou .p12. O A3 fica em token, cartão ou nuvem, e o navegador não tem acesso direto a ele.",
  },
};

export const signFreePage: ToolPage = {
  path: "assine-documentos-gratis",
  tone: "dark",
  kind: "signer",
  anchor: "assinar",
  title: "Assinar PDF grátis com certificado digital A1",
  description:
    "Assine PDF grátis com certificado digital A1 ICP-Brasil, no padrão PAdES. Sem cadastro: o PDF, o certificado e a senha não saem do seu navegador.",
  social: "Assinar PDF grátis",
  nav: { label: tool.sign.label, hint: tool.sign.hint, glyph: "pen" },
  eyebrow: "Assinador de PDF grátis",
  heading: "Assine PDF com certificado digital A1.",
  lead: "Assinatura qualificada ICP-Brasil feita no seu navegador. Escolha o certificado, digite a senha, adicione os PDFs e baixe os arquivos assinados.",
  facts: [
    { glyph: "lock", text: "O PDF, o certificado e a senha não saem do seu dispositivo" },
    { glyph: "zap", text: "Sem cadastro, até 100 PDFs por vez" },
    { glyph: "check", text: "Assinatura qualificada ICP-Brasil, no padrão PAdES" },
  ],
  stepsTitle: "Como assinar um PDF com certificado A1",
  stepsLead: "São quatro passos, todos no seu navegador.",
  steps: [
    {
      title: "Carregue o certificado A1",
      body: "Escolha o arquivo .pfx ou .p12 e digite a senha do certificado.",
    },
    { title: "Escolha os PDFs", body: "Os arquivos são lidos no próprio navegador, sem upload." },
    {
      title: "Posicione a assinatura",
      body: "Clique onde a assinatura deve aparecer ou use o posicionamento automático.",
    },
    { title: "Assine e baixe", body: "Clique em Assinar e baixe os PDFs assinados em PAdES." },
  ],
  outcomesTitle: "O que você recebe",
  outcomes: [
    {
      title: "PDF assinado em PAdES",
      body: "O padrão de assinatura de PDF da ICP-Brasil, com a cadeia do seu certificado incluída no arquivo.",
    },
    {
      title: "Validação independente",
      body: "Confira a assinatura no Validar do ITI ou no Adobe Acrobat Reader, sem depender do SignatureKit.",
    },
    {
      title: "Carimbo visível e rubricas",
      body: "No modo Completa, posicione o carimbo na página certa e rubrique as demais.",
    },
    {
      title: "Lote de até 100 PDFs",
      body: "Assine contratos, aditivos e procurações de uma vez, com o mesmo certificado.",
    },
  ],
  aside: legalAside,
  faqLead:
    "Não encontrou sua dúvida? A documentação explica como a assinatura funciona no navegador.",
  faqLink: { label: "Ver a documentação →", href: docs.browser.href },
  faqs: [
    signerFaqs.legal,
    signerFaqs.signup,
    signerFaqs.server,
    signerFaqs.check,
    signerFaqs.a3,
    {
      question: "Posso assinar vários PDFs de uma vez?",
      answer:
        "Sim. Escolha até 100 PDFs. Todos são assinados com o mesmo certificado, um de cada vez.",
    },
    {
      question: "Dá para escolher onde a assinatura aparece?",
      answer:
        "Sim. Clique na página para posicionar a assinatura. No modo Completa você também ajusta a aparência do carimbo e pode rubricar as demais páginas.",
    },
  ],
  related: [tool.verify, tool.batch, tool.rubric, blog.niveis],
  app: {
    name: "Assinador de PDF grátis do SignatureKit",
    howTo: "Como assinar um PDF com certificado digital A1",
    totalTime: "PT2M",
  },
};

const batchPage: ToolPage = {
  path: "assinar-pdf-em-lote",
  tone: "dark",
  kind: "signer",
  preset: "lote",
  anchor: "assinar",
  title: "Assinar PDF em lote com certificado A1, grátis",
  description:
    "Assine até 100 PDFs de uma vez com certificado digital A1, no padrão PAdES. Grátis e sem cadastro: os arquivos não saem do seu navegador.",
  social: "Assinar PDF em lote",
  nav: { label: tool.batch.label, hint: tool.batch.hint, glyph: "zap" },
  eyebrow: "Assinatura de PDF em lote",
  heading: "Assine vários PDFs de uma vez.",
  lead: "Carregue o certificado A1, adicione até 100 PDFs e assine todos em sequência. Cada arquivo recebe uma assinatura qualificada ICP-Brasil, feita no seu navegador.",
  facts: [
    { glyph: "zap", text: "Até 100 PDFs por lote, com o mesmo certificado" },
    { glyph: "lock", text: "Os PDFs, o certificado e a senha não saem do seu dispositivo" },
    { glyph: "check", text: "Assinatura PAdES em cada arquivo" },
  ],
  stepsTitle: "Como assinar PDFs em lote",
  stepsLead: "O certificado é carregado uma vez e vale para o lote inteiro.",
  steps: [
    {
      title: "Carregue o certificado A1",
      body: "Escolha o arquivo .pfx ou .p12 e digite a senha do certificado.",
    },
    {
      title: "Adicione os PDFs",
      body: "Arraste até 100 arquivos de uma vez ou escolha no computador.",
    },
    {
      title: "Assine o lote",
      body: "No modo Rápida, a assinatura é posicionada automaticamente em cada documento.",
    },
    {
      title: "Baixe os arquivos",
      body: "Cada PDF assinado ganha um link de download assim que fica pronto.",
    },
  ],
  outcomesTitle: "O que o lote entrega",
  outcomes: [
    {
      title: "Uma assinatura por arquivo",
      body: "Cada PDF é assinado separadamente e pode ser validado sozinho.",
    },
    {
      title: "Progresso por documento",
      body: "A página mostra o andamento e permite cancelar o lote a qualquer momento.",
    },
    {
      title: "Posicionamento automático",
      body: "A assinatura procura a linha ou o campo de assinatura do documento.",
    },
    {
      title: "Ajuste manual quando precisar",
      body: "No modo Completa, revise a posição documento por documento antes de assinar.",
    },
  ],
  aside: legalAside,
  faqLead: "Quer assinar em lote dentro do seu sistema? A biblioteca faz o mesmo no servidor.",
  faqLink: { label: "Ver a documentação →", href: docs.pdf.href },
  faqs: [
    {
      question: "Quantos PDFs posso assinar de uma vez?",
      answer: "Até 100 por lote. Para mais arquivos, repita o processo com um novo lote.",
    },
    {
      question: "Os PDFs são assinados ao mesmo tempo?",
      answer:
        "Eles são assinados um de cada vez, em sequência, com o mesmo certificado. O progresso aparece na página.",
    },
    {
      question: "A assinatura fica na mesma posição em todos?",
      answer:
        "No modo Rápida, a posição é escolhida automaticamente em cada documento. No modo Completa, você revisa e ajusta a posição de cada PDF.",
    },
    signerFaqs.server,
    signerFaqs.legal,
    signerFaqs.a3,
    {
      question: "Posso cancelar no meio do lote?",
      answer:
        "Sim. Os PDFs já assinados continuam disponíveis para download e os demais ficam sem assinatura.",
    },
  ],
  related: [tool.sign, tool.rubric, tool.verify, blog.a1a3],
  app: {
    name: "Assinador de PDF em lote do SignatureKit",
    howTo: "Como assinar vários PDFs de uma vez com certificado A1",
    totalTime: "PT3M",
  },
};

const rubricPage: ToolPage = {
  path: "rubricar-pdf",
  tone: "light",
  kind: "signer",
  preset: "rubrica",
  anchor: "assinar",
  title: "Rubricar PDF online com certificado A1, grátis",
  description:
    "Rubrique as páginas de um PDF e assine com certificado digital A1, no padrão PAdES. Grátis, sem cadastro e sem enviar o arquivo a servidores.",
  social: "Rubricar PDF",
  nav: { label: tool.rubric.label, hint: tool.rubric.hint, glyph: "signature" },
  eyebrow: "Rubrica e assinatura de PDF",
  heading: "Rubrique e assine PDF com certificado A1.",
  lead: "Marque as páginas com a sua rubrica e aplique a assinatura digital na página que você escolher. O PDF, o certificado e a senha ficam no seu navegador.",
  facts: [
    { glyph: "signature", text: "Rubrica em todas as páginas, menos a da assinatura" },
    { glyph: "lock", text: "O PDF, o certificado e a senha não saem do seu dispositivo" },
    { glyph: "check", text: "Uma assinatura PAdES cobre o documento inteiro" },
  ],
  stepsTitle: "Como rubricar um PDF",
  stepsLead: "A opção de rubrica já vem ligada no formulário desta página.",
  steps: [
    {
      title: "Carregue o certificado A1",
      body: "Escolha o arquivo .pfx ou .p12, digite a senha e clique em Carregar.",
    },
    { title: "Escolha o PDF", body: "O arquivo é lido no navegador, sem upload." },
    {
      title: "Posicione a assinatura",
      body: "Clique na página onde o carimbo da assinatura deve ficar. As outras recebem a rubrica.",
    },
    {
      title: "Assine e baixe",
      body: "A página aplica as rubricas, assina o documento e libera o download.",
    },
  ],
  outcomesTitle: "Como a rubrica funciona",
  outcomes: [
    {
      title: "Rubrica com o seu nome",
      body: "Gerada a partir do nome do certificado ou de um texto que você digita.",
    },
    {
      title: "Todas as páginas marcadas",
      body: "A página da assinatura recebe o carimbo completo e as demais recebem a rubrica.",
    },
    {
      title: "Assinatura digital única",
      body: "A assinatura PAdES é aplicada depois das rubricas e protege o arquivo inteiro.",
    },
    {
      title: "Carimbo ajustável",
      body: "Defina título, cor, logo e quais dados do signatário aparecem.",
    },
  ],
  aside: {
    title: "Rubrica e assinatura digital",
    lead: "A rubrica é uma marca visual que mostra que cada página foi vista. Quem garante a autoria e a integridade do documento é a assinatura digital com certificado ICP-Brasil.",
    link: { label: "Entender os níveis de assinatura →", href: blog.niveis.href },
    items: [
      {
        title: "Rubrica",
        body: "Marca visual em cada página. Sozinha, não identifica o signatário nem detecta alterações.",
        current: false,
      },
      {
        title: "Assinatura digital",
        body: "Cobre todos os bytes do PDF, incluindo as rubricas. Qualquer alteração posterior aparece na validação.",
        current: true,
      },
    ],
  },
  faqLead: "Quer rubricar e assinar dentro do seu sistema? A biblioteca expõe as mesmas opções.",
  faqLink: { label: "Ver a documentação →", href: docs.browser.href },
  faqs: [
    {
      question: "A rubrica é uma assinatura digital?",
      answer:
        "Não. A rubrica é uma marca visual em cada página. A validade do documento vem da assinatura digital com certificado ICP-Brasil, que cobre o arquivo inteiro, incluindo as rubricas.",
    },
    {
      question: "Em quais páginas a rubrica aparece?",
      answer:
        "Em todas, menos na página que recebe o carimbo completo da assinatura. Um PDF de uma página recebe só o carimbo.",
    },
    {
      question: "Posso escolher o texto da rubrica?",
      answer:
        "Sim. Use o nome do certificado ou digite um texto, em Aparência do carimbo, no modo Completa.",
    },
    signerFaqs.server,
    signerFaqs.legal,
    signerFaqs.a3,
  ],
  related: [tool.sign, tool.batch, tool.verify, blog.niveis],
  app: {
    name: "Rubricador de PDF do SignatureKit",
    howTo: "Como rubricar e assinar um PDF com certificado A1",
    totalTime: "PT3M",
  },
};

const verifyPage: ToolPage = {
  path: "verificar-assinatura-pdf",
  tone: "light",
  kind: "verify",
  anchor: "verificar",
  title: "Verificar assinatura digital de PDF online, grátis",
  description:
    "Verifique a assinatura digital de um PDF no navegador: veja quem assinou, o CPF ou CNPJ, o emissor do certificado e se o arquivo foi alterado.",
  social: "Verificar assinatura de PDF",
  nav: { label: tool.verify.label, hint: tool.verify.hint, glyph: "search" },
  eyebrow: "Verificador de assinatura de PDF",
  heading: "Verifique a assinatura digital de um PDF.",
  lead: "Solte um PDF assinado e veja quem assinou, com qual certificado e se o conteúdo mudou depois da assinatura. A leitura acontece no seu navegador.",
  facts: [
    { glyph: "lock", text: "O PDF não sai do seu dispositivo" },
    { glyph: "search", text: "Signatário, CPF ou CNPJ e emissor do certificado" },
    { glyph: "check", text: "Integridade conferida assinatura por assinatura" },
  ],
  stepsTitle: "Como verificar a assinatura de um PDF",
  stepsLead: "Não precisa de cadastro nem de certificado.",
  steps: [
    {
      title: "Escolha o PDF assinado",
      body: "Arraste o arquivo ou escolha no computador. Ele é lido localmente, sem upload.",
    },
    {
      title: "Confira cada assinatura",
      body: "A página lista o signatário, o CPF ou CNPJ, o emissor e a validade do certificado.",
    },
    {
      title: "Veja se o arquivo mudou",
      body: "Cada assinatura informa se o conteúdo coberto por ela continua igual ao que foi assinado.",
    },
    {
      title: "Valide no ITI quando precisar",
      body: "Para um relatório oficial de conformidade com a ICP-Brasil, envie o PDF ao Validar do ITI.",
    },
  ],
  outcomesTitle: "O que a verificação mostra",
  outcomes: [
    {
      title: "Quem assinou",
      body: "Nome do titular e CPF ou CNPJ gravados no certificado.",
    },
    {
      title: "Integridade",
      body: "Se o trecho do PDF coberto pela assinatura continua exatamente como foi assinado.",
    },
    {
      title: "Certificado",
      body: "Emissor e período de validade do certificado usado na assinatura.",
    },
    {
      title: "Data informada",
      body: "A data registrada na assinatura, que vem do relógio de quem assinou.",
    },
  ],
  aside: {
    title: "Verificação local e validação oficial",
    lead: "Conferir a integridade mostra que o arquivo não mudou depois de assinado. A validade jurídica da assinatura qualificada depende também da cadeia de certificação da ICP-Brasil e da situação do certificado, e quem atesta isso é o Validar do ITI.",
    link: { label: "Abrir o Validar do ITI →", href: "https://validar.iti.gov.br" },
    items: [
      {
        title: "O que esta página confere",
        body: "A integridade do conteúdo assinado, os dados do signatário e a validade declarada no certificado.",
        current: true,
      },
      {
        title: "O que ela não confere",
        body: "A cadeia até a AC Raiz da ICP-Brasil, a revogação do certificado e o carimbo do tempo.",
        current: false,
      },
      {
        title: "Onde validar oficialmente",
        body: "No Validar do ITI (validar.iti.gov.br), que emite o relatório de conformidade.",
        current: false,
      },
    ],
  },
  faqLead: "Quer verificar assinaturas dentro do seu sistema? A biblioteca faz a mesma checagem.",
  faqLink: { label: "Ver a referência de PDF →", href: docs.pdf.href },
  faqs: [
    {
      question: "A verificação desta página tem valor jurídico?",
      answer:
        "Não. Ela mostra se o arquivo foi alterado e quem consta como signatário, mas não valida a cadeia da ICP-Brasil nem a revogação do certificado. Para isso, use o Validar do ITI (validar.iti.gov.br).",
    },
    {
      question: "O PDF é enviado para algum servidor?",
      answer: "Não. O arquivo é lido e verificado na memória do seu navegador.",
    },
    {
      question: "O que significa “Íntegra”?",
      answer:
        "Que o trecho do PDF coberto pela assinatura é exatamente o que foi assinado. Qualquer alteração nesse trecho faz a assinatura aparecer como inválida.",
    },
    {
      question: "E “Cobertura parcial”?",
      answer:
        "A assinatura confere, mas não cobre o arquivo até o fim ou não termina em uma revisão completa do PDF. Pode haver conteúdo incluído depois dela.",
    },
    {
      question: "Funciona com PDFs assinados em outros sistemas?",
      answer:
        "Sim, desde que a assinatura esteja embutida no PDF. Arquivos com carimbo do tempo de documento (DocTimeStamp) ainda não são verificados aqui. Nesse caso, use o Validar do ITI.",
    },
    {
      question: "Por que a data aparece como “informada”?",
      answer:
        "Porque ela vem do relógio do computador de quem assinou. Só um carimbo do tempo emitido por uma autoridade comprova o momento da assinatura.",
    },
    {
      question: "Posso verificar um PDF com várias assinaturas?",
      answer: "Sim. Cada assinatura aparece em um cartão, na ordem em que foi aplicada.",
    },
  ],
  related: [blog.validar, tool.sign, tool.certificate, docs.pdf],
  app: {
    name: "Verificador de assinatura de PDF do SignatureKit",
    howTo: "Como verificar a assinatura digital de um PDF",
    totalTime: "PT1M",
  },
};

const certificatePage: ToolPage = {
  path: "ler-certificado-pfx",
  tone: "dark",
  kind: "certificate",
  anchor: "ler",
  title: "Ler certificado digital A1 (.pfx ou .p12) online",
  description:
    "Abra um certificado A1 (.pfx ou .p12) no navegador e veja titular, CPF ou CNPJ, emissor e validade. O arquivo e a senha não saem do seu dispositivo.",
  social: "Ler certificado A1",
  nav: { label: tool.certificate.label, hint: tool.certificate.hint, glyph: "key" },
  eyebrow: "Leitor de certificado A1",
  heading: "Veja o que há no seu certificado A1.",
  lead: "Escolha o arquivo .pfx ou .p12, digite a senha e confira titular, CPF ou CNPJ, emissor e validade. O certificado é lido no seu navegador.",
  facts: [
    { glyph: "lock", text: "O certificado e a senha não saem do seu dispositivo" },
    { glyph: "key", text: "Aceita arquivos .pfx e .p12" },
    { glyph: "check", text: "Mostra a validade e quantos dias faltam para expirar" },
  ],
  stepsTitle: "Como ler um certificado .pfx",
  stepsLead: "São três passos e nenhum cadastro.",
  steps: [
    { title: "Escolha o arquivo", body: "Selecione o .pfx ou .p12 do seu certificado A1." },
    {
      title: "Digite a senha",
      body: "É a senha definida quando o certificado foi emitido ou exportado.",
    },
    {
      title: "Confira os dados",
      body: "Titular, CPF ou CNPJ, emissor, validade, número de série e impressão digital.",
    },
  ],
  outcomesTitle: "O que a leitura mostra",
  outcomes: [
    {
      title: "Titular e documento",
      body: "Nome do titular e CPF (e-CPF) ou CNPJ (e-CNPJ) gravados no certificado.",
    },
    {
      title: "Validade",
      body: "Datas de início e fim e quantos dias faltam para o certificado expirar.",
    },
    { title: "Emissor", body: "A autoridade certificadora que emitiu o certificado." },
    {
      title: "Identificadores",
      body: "Número de série e impressão digital SHA-256, úteis em suporte e auditoria.",
    },
  ],
  aside: {
    title: "A1 e A3",
    lead: "O A1 é um arquivo protegido por senha, com validade de um ano. O A3 fica em token, cartão ou nuvem e não pode ser copiado como arquivo, por isso não é lido por esta página.",
    link: { label: "Comparar A1 e A3 →", href: blog.a1a3.href },
    items: [
      {
        title: "A1",
        body: "Arquivo .pfx ou .p12 guardado no computador ou no servidor. É o tipo lido aqui.",
        current: true,
      },
      {
        title: "A3",
        body: "Chave em token, cartão inteligente, nuvem ou HSM. Exige o dispositivo ou o serviço do emissor.",
        current: false,
      },
    ],
  },
  faqLead: "Precisa ler certificados no seu sistema? A biblioteca expõe os mesmos dados.",
  faqLink: { label: "Ver a referência de certificados →", href: docs.certificates.href },
  faqs: [
    {
      question: "É seguro digitar a senha do certificado aqui?",
      answer:
        "A leitura acontece na memória do seu navegador. O arquivo e a senha não são enviados nem gravados. O código é aberto e pode ser auditado no GitHub.",
    },
    {
      question: "Esqueci a senha do certificado. Dá para recuperar?",
      answer:
        "Não por esta página. A senha protege a chave privada e não fica guardada em lugar nenhum do arquivo. Sem ela, o caminho é emitir um novo certificado com a sua autoridade certificadora.",
    },
    {
      question: "Funciona com certificado A3?",
      answer:
        "Não. O A3 fica em token, cartão ou nuvem, e a chave não pode ser exportada como arquivo.",
    },
    {
      question: "Como sei se o certificado é ICP-Brasil?",
      answer:
        "Confira o emissor mostrado na leitura: certificados ICP-Brasil são emitidos por autoridades certificadoras credenciadas pelo ITI. Esta página lê os dados do certificado, mas não valida a cadeia de certificação.",
    },
    {
      question: "Qual a diferença entre .pfx e .p12?",
      answer:
        "Na prática, nenhuma. As duas extensões indicam o mesmo formato, o PKCS#12, que guarda o certificado e a chave privada protegidos por senha.",
    },
    {
      question: "Um certificado expirado ainda é lido?",
      answer:
        "Sim. A página mostra os dados e avisa que ele expirou. Um certificado expirado não serve para novas assinaturas.",
    },
  ],
  related: [blog.a1a3, tool.sign, tool.xml, docs.certificates],
  app: {
    name: "Leitor de certificado A1 do SignatureKit",
    howTo: "Como ler um certificado digital .pfx ou .p12",
    totalTime: "PT1M",
  },
};

const xmlPage: ToolPage = {
  path: "assinar-xml-com-certificado-a1",
  tone: "dark",
  kind: "xml",
  anchor: "assinar",
  title: "Assinar XML com certificado A1 online (XML-DSig)",
  description:
    "Assine um arquivo XML com certificado A1 no padrão XML-DSig, direto no navegador. O XML, o certificado e a senha não saem do seu dispositivo.",
  social: "Assinar XML com A1",
  nav: { label: tool.xml.label, hint: tool.xml.hint, glyph: "terminal" },
  eyebrow: "Assinador de XML",
  heading: "Assine XML com certificado A1.",
  lead: "Gere uma assinatura XML-DSig enveloped com o seu certificado ICP-Brasil e baixe o arquivo assinado. O XML, o certificado e a senha ficam no seu navegador.",
  facts: [
    { glyph: "lock", text: "Nada é enviado a servidores" },
    { glyph: "signature", text: "XML-DSig enveloped com RSA-SHA256" },
    { glyph: "check", text: "A assinatura é conferida logo depois de gerada" },
  ],
  stepsTitle: "Como assinar um XML com certificado A1",
  stepsLead: "São quatro passos, todos no seu navegador.",
  steps: [
    { title: "Escolha o XML", body: "O arquivo precisa estar em UTF-8. Ele é lido no navegador." },
    {
      title: "Carregue o certificado A1",
      body: "Selecione o arquivo .pfx ou .p12 e digite a senha.",
    },
    {
      title: "Defina o que assinar",
      body: "Deixe em branco para assinar o documento inteiro ou informe o Id de um elemento.",
    },
    {
      title: "Assine e baixe",
      body: "A página gera a assinatura, confere o resultado e libera o download.",
    },
  ],
  outcomesTitle: "O que a página gera",
  outcomes: [
    {
      title: "Assinatura enveloped",
      body: "O elemento Signature é inserido dentro do próprio XML, como define o XML-DSig.",
    },
    {
      title: "RSA-SHA256",
      body: "Resumo SHA-256 do conteúdo e assinatura RSA com a chave do seu certificado.",
    },
    {
      title: "Canonicalização exclusiva",
      body: "O conteúdo é normalizado com Exclusive C14N antes do cálculo do resumo.",
    },
    {
      title: "Certificado incluído",
      body: "O certificado X.509 do signatário vai em KeyInfo, para quem for validar.",
    },
  ],
  aside: {
    title: "Layouts fiscais têm regras próprias",
    lead: "Documentos como a NF-e usam XML-DSig, mas definem qual elemento assinar, onde a assinatura fica e quais algoritmos usar. Esta página gera uma assinatura XML-DSig genérica e não valida o XML contra esses layouts.",
    link: { label: "Como funciona a assinatura de XML →", href: blog.xml.href },
    items: [
      {
        title: "O que esta página faz",
        body: "Assina o documento inteiro ou um elemento identificado por Id, com Exclusive C14N e RSA-SHA256.",
        current: true,
      },
      {
        title: "O que ela não faz",
        body: "Não valida schemas, não transmite documentos e não aplica regras de layouts como NF-e, NFS-e ou eSocial.",
        current: false,
      },
      {
        title: "Para integrar ao seu sistema",
        body: "Use a biblioteca: a função signXml aceita algoritmo, canonicalização e referência.",
        current: false,
      },
    ],
  },
  faqLead: "Precisa assinar XML no seu sistema? A mesma função roda no servidor e no navegador.",
  faqLink: { label: "Ver a referência de XML →", href: docs.xml.href },
  faqs: [
    {
      question: "O que é XML-DSig?",
      answer:
        "É o padrão do W3C para assinar documentos XML. A assinatura fica em um elemento Signature, com o resumo do conteúdo, o valor da assinatura e o certificado do signatário.",
    },
    {
      question: "Serve para NF-e, NFS-e ou eSocial?",
      answer:
        "Esses documentos usam XML-DSig, mas cada layout define o elemento assinado, a posição da assinatura e os algoritmos. Esta página gera uma assinatura genérica e não garante conformidade com esses layouts. Para emissão fiscal, use o seu sistema emissor.",
    },
    {
      question: "O XML é enviado para algum servidor?",
      answer:
        "Não. O XML, o certificado e a senha ficam na memória do seu navegador durante a assinatura.",
    },
    {
      question: "O que é o Id do elemento?",
      answer:
        "É o valor do atributo Id do elemento que será assinado. Com ele, a referência da assinatura aponta para esse elemento. Em branco, a assinatura cobre o documento inteiro.",
    },
    {
      question: "Funciona com certificado A3?",
      answer:
        "Não. Esta página assina apenas com certificado A1, o arquivo .pfx ou .p12. O A3 fica em token, cartão ou nuvem, e o navegador não tem acesso direto a ele.",
    },
    {
      question: "Como confiro a assinatura depois?",
      answer:
        "A página confere a assinatura com o seu certificado logo depois de gerar. No seu sistema, use a função verifyXml do SignatureKit ou outro validador de XML-DSig.",
    },
    {
      question: "Meu XML não está em UTF-8. E agora?",
      answer:
        "Converta o arquivo para UTF-8 antes de assinar. A página recusa outras codificações para não corromper os acentos.",
    },
  ],
  related: [blog.xml, tool.certificate, tool.sign, docs.xml],
  app: {
    name: "Assinador de XML do SignatureKit",
    howTo: "Como assinar um XML com certificado digital A1",
    totalTime: "PT2M",
  },
};

export const toolPages: ReadonlyArray<ToolPage> = [
  signFreePage,
  batchPage,
  rubricPage,
  verifyPage,
  certificatePage,
  xmlPage,
];

export const toolPageAt = (route: string) => toolPages.find((page) => `/${page.path}` === route);

export const toolPageStructuredData = (page: ToolPage, origin: string) => {
  const url = `${origin}/${page.path}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: page.app.name,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url,
        description: page.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "BRL" },
      },
      {
        "@type": "HowTo",
        name: page.app.howTo,
        description: page.description,
        totalTime: page.app.totalTime,
        step: page.steps.map((step, index) => ({
          "@type": "HowToStep",
          position: index + 1,
          name: step.title,
          text: step.body,
          url: `${url}#${page.anchor}`,
        })),
      },
      {
        "@type": "FAQPage",
        mainEntity: page.faqs.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      },
    ],
  };
};

const external = <Message>(h: HtmlBuilder<Message>, href: string) =>
  href.startsWith("http") ? [h.Target("_blank"), h.Rel("noopener")] : [];

type Faq<Message> = {
  open: Option.Option<number>;
  toggle: (index: number, open: boolean) => Message;
};

const factList = <Message>(h: HtmlBuilder<Message>, page: ToolPage, light: boolean) =>
  h.ul(
    [...sx(h, landing.signFacts, light && pages.factsLight)],
    page.facts.map((fact) =>
      h.keyed("li")(
        fact.text,
        [...sx(h, landing.signFact)],
        [
          h.span(
            [...sx(h, landing.signFactIcon, light && pages.factIconLight)],
            [icon(h, fact.glyph)],
          ),
          fact.text,
        ],
      ),
    ),
  );

const stepItems = <Message>(h: HtmlBuilder<Message>, page: ToolPage) =>
  page.steps.map((step, index) =>
    h.keyed("li")(
      step.title,
      [...sx(h, landing.railItem)],
      [
        h.span(
          [...sx(h, landing.railNumber), h.AriaHidden(true)],
          [String(index + 1).padStart(2, "0")],
        ),
        h.div(
          [],
          [
            h.h3([...sx(h, landing.cellTitle)], [step.title]),
            h.p([...sx(h, landing.cellBody)], [step.body]),
          ],
        ),
      ],
    ),
  );

const outcomeRail = <Message>(h: HtmlBuilder<Message>, page: ToolPage) => [
  h.h3([...sx(h, landing.railHeading), h.Attribute("data-reveal", "")], [page.outcomesTitle]),
  h.ul(
    [
      ...sx(h, landing.rail, landing.railPlain),
      h.Attribute("data-reveal", ""),
      h.Attribute("data-reveal-stagger", ""),
    ],
    page.outcomes.map((item) =>
      h.keyed("li")(
        item.title,
        [...sx(h, landing.railItem, landing.railItemPlain)],
        [
          h.div(
            [],
            [
              h.h4([...sx(h, landing.cellTitle)], [item.title]),
              h.p([...sx(h, landing.cellBody)], [item.body]),
            ],
          ),
        ],
      ),
    ),
  ),
];

const stepsRail = <Message>(h: HtmlBuilder<Message>, page: ToolPage) =>
  h.section(
    [...sx(h, landing.section)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], [page.stepsTitle]),
          h.p([...sx(h, landing.lead)], [page.stepsLead]),
        ],
      ),
      h.ol(
        [
          ...sx(h, landing.rail, page.steps.length === 3 && landing.railThree),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        stepItems(h, page),
      ),
      ...outcomeRail(h, page),
    ],
  );

const stepsPath = <Message>(h: HtmlBuilder<Message>, page: ToolPage) =>
  h.section(
    [...sx(h, landing.section, landing.split)],
    [
      h.div(
        [...sx(h, landing.head, pages.sticky), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], [page.stepsTitle]),
          h.p([...sx(h, landing.lead)], [page.stepsLead]),
        ],
      ),
      h.ol(
        [
          ...sx(h, pages.path),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        page.steps.map((step, index) =>
          h.keyed("li")(
            step.title,
            [...sx(h, pages.pathItem)],
            [
              h.span([...sx(h, pages.pathNumber), h.AriaHidden(true)], [String(index + 1)]),
              h.div(
                [],
                [
                  h.h3([...sx(h, landing.cellTitle)], [step.title]),
                  h.p([...sx(h, landing.cellBody)], [step.body]),
                ],
              ),
            ],
          ),
        ),
      ),
    ],
  );

const outcomeGrid = <Message>(h: HtmlBuilder<Message>, page: ToolPage, mono: boolean) =>
  h.section(
    [...sx(h, landing.section, pages.tight)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [h.h2([...sx(h, landing.sectionTitle)], [page.outcomesTitle])],
      ),
      h.ul(
        [
          ...sx(h, pages.tiles),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        page.outcomes.map((item) =>
          h.keyed("li")(
            item.title,
            [...sx(h, pages.tile)],
            [
              h.h3([...sx(h, landing.cellTitle, mono && pages.tileMono)], [item.title]),
              h.p([...sx(h, landing.cellBody)], [item.body]),
            ],
          ),
        ),
      ),
    ],
  );

const asideLevels = <Message>(h: HtmlBuilder<Message>, page: ToolPage) =>
  h.section(
    [...sx(h, landing.section, landing.split)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], [page.aside.title]),
          h.p([...sx(h, landing.lead)], [page.aside.lead]),
          h.a(
            [
              ...sx(h, landing.textLink),
              h.Href(page.aside.link.href),
              ...external(h, page.aside.link.href),
            ],
            [page.aside.link.label],
          ),
        ],
      ),
      h.ol(
        [
          ...sx(h, landing.levels),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        page.aside.items.map((item) =>
          h.keyed("li")(
            item.title,
            [...sx(h, landing.level, item.current && landing.levelCurrent)],
            [
              h.strong([...sx(h, landing.levelHead)], [item.title]),
              h.p([...sx(h, landing.cellBody)], [item.body]),
            ],
          ),
        ),
      ),
    ],
  );

const asideLedger = <Message>(h: HtmlBuilder<Message>, page: ToolPage) =>
  h.section(
    [...sx(h, landing.section)],
    [
      h.div(
        [...sx(h, pages.ledger), h.Attribute("data-reveal", "")],
        [
          h.div(
            [...sx(h, pages.ledgerHead)],
            [
              h.h2([...sx(h, pages.ledgerTitle)], [page.aside.title]),
              h.p([...sx(h, pages.ledgerLead)], [page.aside.lead]),
              h.a(
                [
                  ...sx(h, pages.ledgerLink),
                  h.Href(page.aside.link.href),
                  ...external(h, page.aside.link.href),
                ],
                [page.aside.link.label],
              ),
            ],
          ),
          h.ul(
            [...sx(h, pages.ledgerRows)],
            page.aside.items.map((item) =>
              h.keyed("li")(
                item.title,
                [...sx(h, pages.ledgerRow)],
                [
                  h.span(
                    [...sx(h, pages.ledgerMark, item.current && pages.ledgerMarkOn)],
                    [icon(h, item.current ? "check" : "info")],
                  ),
                  h.div(
                    [],
                    [
                      h.strong([...sx(h, pages.ledgerItem)], [item.title]),
                      h.p([...sx(h, pages.ledgerBody)], [item.body]),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );

const faqItems = <Message>(h: HtmlBuilder<Message>, page: ToolPage, faq: Faq<Message>) =>
  page.faqs.map((item, index) =>
    h.keyed("div")(
      item.question,
      [],
      [
        Disclosure.view(
          {
            id: `tool-faq-${index}`,
            isOpen: Option.contains(index)(faq.open),
            onToggle: (open) => faq.toggle(index, open),
            toView: ({ button, animatePanel }) =>
              h.div(
                [...sx(h, landing.faq)],
                [
                  h.h3(
                    [...sx(h, landing.faqHeading)],
                    [
                      h.button(
                        [...button, ...sx(h, landing.faqButton)],
                        [
                          item.question,
                          h.span(
                            [
                              ...sx(
                                h,
                                landing.faqChevron,
                                Option.contains(index)(faq.open) && landing.faqChevronOpen,
                              ),
                            ],
                            [icon(h, "chevron")],
                          ),
                        ],
                      ),
                    ],
                  ),
                  animatePanel(h.p([...sx(h, landing.faqPanel)], [item.answer])),
                ],
              ),
          },
          h,
        ),
      ],
    ),
  );

const faqSplit = <Message>(h: HtmlBuilder<Message>, page: ToolPage, faq: Faq<Message>) =>
  h.section(
    [...sx(h, landing.section, landing.split)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["Perguntas frequentes"]),
          h.p([...sx(h, landing.lead)], [page.faqLead]),
          h.a([...sx(h, landing.textLink), h.Href(page.faqLink.href)], [page.faqLink.label]),
        ],
      ),
      h.div([], faqItems(h, page, faq)),
    ],
  );

const faqColumn = <Message>(h: HtmlBuilder<Message>, page: ToolPage, faq: Faq<Message>) =>
  h.section(
    [...sx(h, landing.section, pages.narrow)],
    [
      h.div(
        [...sx(h, landing.head, pages.centered), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["Perguntas frequentes"]),
          h.p([...sx(h, landing.lead)], [page.faqLead]),
          h.a([...sx(h, landing.textLink), h.Href(page.faqLink.href)], [page.faqLink.label]),
        ],
      ),
      h.div([], faqItems(h, page, faq)),
    ],
  );

const relatedKind = (href: string) =>
  href.startsWith("/blog/") ? "Artigo" : href.startsWith("/docs/") ? "Documentação" : "Ferramenta";

export const relatedSection = <Message>(
  h: HtmlBuilder<Message>,
  links: ReadonlyArray<ToolPageLink>,
) =>
  h.section(
    [...sx(h, landing.section)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [h.h2([...sx(h, landing.sectionTitle)], ["Continue por aqui"])],
      ),
      h.ul(
        [
          ...sx(h, landing.related),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        links.map((link) =>
          h.keyed("li")(
            link.href,
            [],
            [
              h.a(
                [...sx(h, landing.relatedCard), h.Href(link.href), ...external(h, link.href)],
                [
                  h.span([...sx(h, landing.relatedKind)], [link.kind ?? relatedKind(link.href)]),
                  h.strong([...sx(h, landing.relatedTitle)], [link.label]),
                  h.span([...sx(h, landing.cellBody)], [link.hint]),
                  h.span([...sx(h, landing.relatedArrow), h.AriaHidden(true)], ["→"]),
                ],
              ),
            ],
          ),
        ),
      ),
    ],
  );

const pageStrip = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 520 150"), h.AriaHidden(true), ...sx(h, pages.strip)],
    [0, 1, 2, 3, 4].flatMap((index) => {
      const x = 6 + index * 104;
      const last = index === 4;
      return [
        h.keyed("rect")(`sheet-${index}`, [
          h.X(String(x)),
          h.Y("6"),
          h.Width("92"),
          h.Height("130"),
          h.Rx("6"),
          ...sx(h, pages.stripSheet),
        ]),
        ...[0, 1, 2, 3].map((line) =>
          h.keyed("path")(`text-${index}-${line}`, [
            h.D(`M${x + 12} ${28 + line * 14}h${line === 3 ? 40 : 68}`),
            ...sx(h, pages.stripText),
          ]),
        ),
        last
          ? h.keyed("rect")("stamp", [
              h.X(String(x + 12)),
              h.Y("92"),
              h.Width("68"),
              h.Height("30"),
              h.Rx("4"),
              ...sx(h, pages.stripStamp),
            ])
          : h.keyed("path")(`rubric-${index}`, [
              h.D(`M${x + 54} 118c5 0 6-12 10-12s-2 14 3 14 4-9 8-9-1 6 3 6`),
              ...sx(h, pages.stripRubric),
            ]),
      ];
    }),
  );

export const toolLanding = <Message>(
  h: HtmlBuilder<Message>,
  page: ToolPage,
  widget: Html,
  faq: Faq<Message>,
): ReadonlyArray<Html> => {
  const copy = (light: boolean, ...extra: Parameters<typeof sx>[1][]) =>
    h.div(
      [...sx(h, landing.signCopy, ...extra), h.Attribute("data-enter", "")],
      [
        h.p([...sx(h, landing.signEyebrow, light && pages.eyebrowLight)], [page.eyebrow]),
        h.h1([...sx(h, landing.signTitle, light && pages.titleLight)], [page.heading]),
        h.p([...sx(h, landing.signLead, light && pages.leadLight)], [page.lead]),
      ],
    );
  if (page.kind === "verify")
    return [
      h.section(
        [...sx(h, pages.lightHero), h.Id(page.anchor)],
        [
          h.div(
            [...sx(h, pages.lightHead)],
            [copy(true), h.div([h.Attribute("data-enter", "")], [factList(h, page, true)])],
          ),
          h.div([...sx(h, pages.wide), h.Attribute("data-enter-card", "")], [widget]),
        ],
      ),
      asideLedger(h, page),
      stepsPath(h, page),
      outcomeGrid(h, page, false),
      faqColumn(h, page, faq),
      relatedSection(h, page.related),
    ];
  if (page.kind === "certificate")
    return [
      h.section(
        [...sx(h, landing.signHero, pages.centerHero), h.Id(page.anchor)],
        [
          h.div(
            [...sx(h, pages.centerInner)],
            [
              copy(false, pages.centered, pages.centerCopy),
              h.div([...sx(h, pages.wide), h.Attribute("data-enter-card", "")], [widget]),
              h.div(
                [...sx(h, pages.factRow), h.Attribute("data-enter", "")],
                [factList(h, page, false)],
              ),
            ],
          ),
        ],
      ),
      stepsRail(h, page),
      asideLevels(h, page),
      faqSplit(h, page, faq),
      relatedSection(h, page.related),
    ];
  if (page.kind === "xml")
    return [
      h.section(
        [...sx(h, landing.signHero, pages.codeHero), h.Id(page.anchor)],
        [
          h.div(
            [...sx(h, pages.codeInner)],
            [
              h.div(
                [...sx(h, pages.codeHead)],
                [
                  copy(false, pages.codeCopy),
                  h.div([h.Attribute("data-enter", "")], [factList(h, page, false)]),
                ],
              ),
              h.div([h.Attribute("data-enter-card", "")], [widget]),
            ],
          ),
        ],
      ),
      outcomeGrid(h, page, true),
      stepsPath(h, page),
      asideLedger(h, page),
      faqColumn(h, page, faq),
      relatedSection(h, page.related),
    ];
  if (page.preset === "rubrica")
    return [
      h.section(
        [...sx(h, pages.lightHero), h.Id(page.anchor)],
        [
          h.div(
            [...sx(h, pages.lightHead)],
            [
              copy(true),
              h.div(
                [...sx(h, pages.stripWrap), h.Attribute("data-enter", "")],
                [pageStrip(h), factList(h, page, true)],
              ),
            ],
          ),
          h.div(
            [
              ...sx(h, landing.signCard, pages.wide, pages.cardLight),
              h.Attribute("data-enter-card", ""),
            ],
            [widget],
          ),
        ],
      ),
      stepsPath(h, page),
      asideLevels(h, page),
      outcomeGrid(h, page, false),
      faqSplit(h, page, faq),
      relatedSection(h, page.related),
    ];
  return [
    h.section(
      [...sx(h, landing.signHero, page.preset === "lote" && pages.batchHero), h.Id(page.anchor)],
      [
        h.div(
          [...sx(h, landing.signHeroInner)],
          [
            h.div(
              [...sx(h, landing.signCopy), h.Attribute("data-enter", "")],
              [
                h.p([...sx(h, landing.signEyebrow)], [page.eyebrow]),
                h.h1([...sx(h, landing.signTitle)], [page.heading]),
                h.p([...sx(h, landing.signLead)], [page.lead]),
                factList(h, page, false),
              ],
            ),
            h.div(
              [
                ...sx(h, landing.signCard, page.preset === "lote" && pages.stacked),
                h.Attribute("data-enter-card", ""),
              ],
              [widget],
            ),
          ],
        ),
      ],
    ),
    ...(page.preset === "lote"
      ? [outcomeGrid(h, page, false), stepsPath(h, page), asideLevels(h, page)]
      : [stepsRail(h, page), asideLevels(h, page)]),
    faqSplit(h, page, faq),
    relatedSection(h, page.related),
  ];
};
