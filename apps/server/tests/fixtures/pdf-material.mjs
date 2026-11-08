// A real, independently specified PDF: cover + printed page 7. No parser mocks.
export function fixedPdf(body = 'Fixed evidence: 37 volts') {
  const lines = body.split('\n'), height = Math.max(200, lines.length * 12 + 60);
  const literals = lines.map(line => line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'));
  const text = lines.length === 1 ? `BT /F1 18 Tf 30 150 Td (${literals[0]}) Tj ET`
    : `BT /F1 9 Tf 30 ${height - 30} Td 12 TL ` + literals.map(line => `(${line}) Tj T*`).join('\n') + ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /P (Cover) >> 1 << /S /D /St 7 >>] >> >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
