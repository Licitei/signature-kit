const encoder = new TextEncoder();

export const buildPdf = (objects: ReadonlyArray<string>, root = 1): Uint8Array => {
  let pdf = "%PDF-1.7\n";
  let xref = encoder.encode(pdf).length;
  const offsets: Array<number> = [];
  objects.forEach((body, index) => {
    offsets.push(xref);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    pdf += object;
    xref += encoder.encode(object).length;
  });
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(pdf);
};

export const stream = (content: string): string =>
  `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`;
