export const marker: readonly [number, number, number, number] = [40, 30, 100, 65];

export const pdfObjects = (objects: readonly string[]): Uint8Array => {
  let source = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = source.length;
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return String(offset).padStart(10, "0");
  });
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.map((offset) => `${offset} 00000 n \n`).join("");
  source += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
};

export const createPages = (count: number): Uint8Array => {
  const content = "0 0 1 rg 40 30 60 35 re f";
  const pages = Array.from({ length: count }, (_, index) => `${index + 4} 0 R`);
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${pages.join(" ")}] >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...pages.map(
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 160] " +
        "/CropBox [20 10 200 130] /Rotate 90 /Contents 3 0 R /Resources << >> >>",
    ),
  ]);
};
