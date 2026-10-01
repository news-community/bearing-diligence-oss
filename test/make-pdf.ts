/**
 * A minimal, valid PDF, written by hand so the extractor can be tested on a real one.
 *
 * Page 1 carries text. Page 2 carries a drawn rectangle and NO text, which is the shape of a
 * scanned page: the extractor must report it as having no text layer rather than as empty prose,
 * because "unread" and "unchanged" are the two things the change record must never confuse.
 */
function esc(s: string): string {
  return s.replace(/([()\\])/g, "\\$1");
}

export function makePdf(linesPage1: string[]): Buffer {
  const content1 =
    "BT /F1 11 Tf 14 TL 56 760 Td\n" + linesPage1.map((l) => `(${esc(l)}) Tj T*`).join("\n") + "\nET\n";
  const content2 = "0.9 0.9 0.9 rg 56 560 500 200 re f\n"; // a grey box, no text at all

  const objects: string[] = [];
  const push = (body: string) => objects.push(body);

  push("<< /Type /Catalog /Pages 2 0 R >>");
  push("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
  push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>");
  push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>");
  push(`<< /Length ${content1.length} >>\nstream\n${content1}endstream`);
  push(`<< /Length ${content2.length} >>\nstream\n${content2}endstream`);
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * A PDF whose page carries an IMAGE of text and no text layer, which is what a scanned packet is.
 *
 * Built so OCR has something real to read: the words are drawn onto a canvas, compressed as a
 * JPEG, and embedded as an image XObject. Extraction finds no text on this page, correctly, and
 * only OCR can say what it says.
 */
export async function makeScannedPdf(lines: string[]): Promise<Buffer> {
  const canvasMod: any = await import("@napi-rs/canvas");
  const W = 1224;
  const H = 1584;
  const canvas = canvasMod.createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "black";
  ctx.font = "34px Helvetica";
  lines.forEach((l, i) => ctx.fillText(l, 90, 150 + i * 56));
  const jpeg: Buffer = canvas.toBuffer("image/jpeg", 0.95);

  const objects: Array<string | Buffer> = [];
  const push = (b: string | Buffer) => objects.push(b);
  const content = `q 612 0 0 792 0 0 cm /Im0 Do Q\n`;

  push("<< /Type /Catalog /Pages 2 0 R >>");
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>");
  push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  push(
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        "latin1",
      ),
      jpeg,
      Buffer.from("\nendstream", "latin1"),
    ]),
  );

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    const b = typeof body === "string" ? Buffer.from(body, "latin1") : body;
    parts.push(head, b, tail);
    at += head.length + b.length + tail.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}


/**
 * A PDF carrying text a reader cannot see, one kind per line, each isolated with q/Q.
 *
 * The isolation matters and was learned by getting it wrong: the graphics state, including the text
 * rendering mode, persists across BT/ET. A first probe set `3 Tr` once and never reset it, so every
 * later line was genuinely invisible too and the screen reported four invisibles where four
 * different kinds were meant. The screen was right and the fixture was wrong, which is the safer
 * way round and is why each case here is wrapped.
 */
export function makeHiddenTextPdf(parts: {
  visible?: string;
  invisible?: string;
  white?: string;
  tiny?: string;
  offpage?: string;
  /** Set at 1pt and scaled by the text matrix to 11pt: visible, the way many real PDFs draw text. */
  scaledUp?: string;
  /** Set at 11pt and scaled by the text matrix to under a point: tiny, however the font was set. */
  scaledDown?: string;
  /** White text on a dark band painted first: visible, the heading row of a table. */
  whiteOnDark?: string;
}): Buffer {
  const body: string[] = [];
  if (parts.visible) body.push(`q BT /F1 11 Tf 0 g 56 760 Td (${esc(parts.visible)}) Tj ET Q`);
  // 3 Tr: glyphs are placed and never painted. This is also what an honest OCR layer under a scan
  // uses, which is the reason invariant 9 marks rather than refuses.
  if (parts.invisible) body.push(`q BT /F1 11 Tf 3 Tr 56 700 Td (${esc(parts.invisible)}) Tj ET Q`);
  if (parts.white) body.push(`q BT /F1 11 Tf 1 1 1 rg 56 640 Td (${esc(parts.white)}) Tj ET Q`);
  if (parts.tiny) body.push(`q BT /F1 0.4 Tf 0 g 56 600 Td (${esc(parts.tiny)}) Tj ET Q`);
  if (parts.offpage) body.push(`q BT /F1 11 Tf 0 g 56 -400 Td (${esc(parts.offpage)}) Tj ET Q`);
  if (parts.scaledUp) body.push(`q BT /F1 1 Tf 0 g 11 0 0 11 56 560 Tm (${esc(parts.scaledUp)}) Tj ET Q`);
  if (parts.scaledDown) body.push(`q BT /F1 11 Tf 0 g 0.05 0 0 0.05 56 520 Tm (${esc(parts.scaledDown)}) Tj ET Q`);
  if (parts.whiteOnDark) body.push(`q 0.1 0.2 0.3 rg 50 470 300 20 re f BT /F1 11 Tf 1 1 1 rg 56 476 Td (${esc(parts.whiteOnDark)}) Tj ET Q`);
  const content = body.join("\n") + "\n";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((b, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}


/**
 * A scanned page WITH an OCR layer under it: a picture of the words, plus the same words in
 * rendering mode 3 so they are selectable and searchable.
 *
 * This is what a scanner produces and what a real board packet often is. It uses the exact
 * mechanism an injection uses, which is why the hidden-text screen has to tell them apart: without
 * that, every line of every scanned packet would be marked.
 */
export async function makeScannedPdfWithOcrLayer(lines: string[]): Promise<Buffer> {
  const canvasMod: any = await import("@napi-rs/canvas");
  const W = 1224;
  const H = 1584;
  const canvas = canvasMod.createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "black";
  ctx.font = "34px Helvetica";
  lines.forEach((l, i) => ctx.fillText(l, 90, 150 + i * 56));
  const jpeg: Buffer = canvas.toBuffer("image/jpeg", 0.95);

  // The picture first, then the invisible text over it, which is the order a scanner writes.
  const text = lines.map((l, i) => `BT /F1 11 Tf 3 Tr 45 ${720 - i * 28} Td (${esc(l)}) Tj ET`).join("\n");
  const content = `q 612 0 0 792 0 0 cm /Im0 Do Q\n${text}\n`;

  const objects: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        "latin1",
      ),
      jpeg,
      Buffer.from("\nendstream", "latin1"),
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    const b = typeof body === "string" ? Buffer.from(body, "latin1") : body;
    parts.push(head, b, tail);
    at += head.length + b.length + tail.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}
