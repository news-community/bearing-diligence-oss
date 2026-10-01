/**
 * Text a reader would not see, found by reading how the page is DRAWN.
 *
 * Invariant 9's second half: a packet's rendered text is compared with its extracted text, and
 * anything a reader would not see is marked. The reason it matters is measured rather than
 * imagined: of 15.3K prompt injections found on the web in 2026, about **70% were in text a
 * browser never renders**. A board packet is written by the party this tool exists
 * to hold at arm's length, so this is the route that matters most here.
 *
 * **The text layer cannot answer this question, which was established by asking it.** pdf.js
 * `getTextContent` reports text in rendering mode 3 (invisible) and text painted white on white
 * IDENTICALLY to ordinary prose: same string, same width, same height, same transform. There is no
 * field that differs. So this module reads `getOperatorList` instead, which is the sequence of
 * drawing commands the page actually contains, and tracks the graphics state the way a renderer
 * would.
 *
 * What it can see, and how each one hides text:
 *
 *   invisible  text rendering mode 3 or 7: the glyphs are placed and never painted. Mode 3 is what
 *              an OCR layer under a scan legitimately uses, which is why this is a MARK and not a
 *              refusal: the same mechanism has an honest use and a dishonest one.
 *   white      the fill colour matches the paper. Near-white counts, because 254,254,254 hides just
 *              as well as 255,255,255 and only a machine can tell them apart.
 *   tiny       a font size below the floor. Text at 0.4pt is present, extractable and unreadable.
 *   offpage    the text matrix places the glyphs outside the media box.
 *
 * **What it cannot see**, stated because a screen that does not say so is worse than none: text
 * covered by an opaque image or rectangle drawn afterwards (this reads the drawing order but does
 * not compute overlap), text in a colour that merely matches a coloured background rather than the
 * page, text inside an annotation or a form field, glyphs whose font maps them to something other
 * than what they claim, and every PDF this cannot parse at all. It is a disclosure to the reader, never a
 * defence (proposal section 10, risk 11).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type HiddenRun = {
  page_no: number;
  /** Why a reader would not see it. */
  reason: "invisible" | "white" | "tiny" | "offpage" | "ocr-layer";
  text: string;
  detail: string;
  /** Whether this text also reached the extracted page text, which is what decides if it matters. */
  in_extracted: boolean;
};

/** CALIBRATE. Below this, text is present and unreadable. Ordinary fine print is 6pt to 8pt. */
export const TINY_POINTS = 3;
/** CALIBRATE. How close to paper-white counts as white. */
export const WHITE_FLOOR = 250;

/**
 * What a renderer keeps that decides visibility. `size` is the font size as set; what reaches the
 * page is that times the text matrix's scale (`tmScale`) times the page transform's (`ctm`), because
 * many PDFs set a 1pt font and scale it with the matrix. Judging `size` alone marked every line of
 * a real board agenda as 1pt text on 2026-09-30.
 */
type Matrix = [number, number, number, number, number, number];
type State = { mode: number; fill: [number, number, number]; size: number; tmScale: number; x: number; y: number; ctm: Matrix };
type Box = { x0: number; y0: number; x1: number; y1: number };

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m: Matrix) => Math.hypot(m[0], m[1]);
const isWhite = (f: [number, number, number]) => f[0] >= WHITE_FLOOR && f[1] >= WHITE_FLOOR && f[2] >= WHITE_FLOOR;

export async function hiddenText(bytes: Buffer, extractedByPage: Map<number, string>): Promise<HiddenRun[]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl =
    join(dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))), "..", "..", "standard_fonts") + "/";
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const OPS = pdfjs.OPS;
  const FILLS = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const out: HiddenRun[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const view = page.view as number[]; // the media box: [x0, y0, x1, y1]
    const ops = await page.getOperatorList();
    const extracted = extractedByPage.get(n) ?? "";

    // The graphics state a renderer would keep. Only the parts that decide visibility.
    let s: State = { mode: 0, fill: [0, 0, 0], size: 12, tmScale: 1, x: 0, y: 0, ctm: IDENTITY };
    const stack: State[] = [];
    // Non-white shapes painted so far, in page space. White text drawn over one is visible: the
    // heading row of a table, white on a dark band, was marked hidden until 2026-09-30.
    const painted: Box[] = [];
    let path: Box | null = null;
    const onPage: HiddenRun[] = [];
    let visibleRuns = 0;
    let sawImage = false;

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as any;

      if (fn === OPS.save) stack.push({ ...s, fill: [...s.fill] as [number, number, number], ctm: [...s.ctm] as Matrix });
      else if (fn === OPS.restore) s = stack.pop() ?? s;
      else if (fn === OPS.setTextRenderingMode) s.mode = Number(args?.[0] ?? 0);
      else if (fn === OPS.setFont) s.size = Math.abs(Number(args?.[1] ?? 12));
      else if (fn === OPS.setFillRGBColor) {
        s.fill = [Number(args?.[0] ?? 0), Number(args?.[1] ?? 0), Number(args?.[2] ?? 0)];
      } else if (fn === OPS.setFillGray) {
        const g = Math.round(Number(args?.[0] ?? 0) * 255);
        s.fill = [g, g, g];
      } else if (fn === OPS.transform) {
        s.ctm = multiply((args as number[]).map(Number) as Matrix, s.ctm);
      } else if (fn === OPS.constructPath) {
        const mm = args?.[2] as number[] | undefined;
        if (mm && mm.length >= 4) {
          const [ax, ay] = apply(s.ctm, mm[0]!, mm[1]!), [bx, by] = apply(s.ctm, mm[2]!, mm[3]!);
          path = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
        }
      } else if (FILLS.has(fn)) {
        if (path && !isWhite(s.fill)) painted.push(path);
        path = null;
      } else if (fn === OPS.beginText) {
        s.x = 0;
        s.y = 0;
        s.tmScale = 1;
      } else if (fn === OPS.moveText) {
        s.x += Number(args?.[0] ?? 0) * s.tmScale;
        s.y += Number(args?.[1] ?? 0) * s.tmScale;
      } else if (fn === OPS.setTextMatrix) {
        s.tmScale = Math.hypot(Number(args?.[0] ?? 1), Number(args?.[1] ?? 0)) || 1;
        s.x = Number(args?.[4] ?? 0);
        s.y = Number(args?.[5] ?? 0);
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintJpegXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageMaskXObject
      ) {
        sawImage = true;
      } else if (fn === OPS.showText) {
        const text = glyphs(args?.[0]);
        if (!text.trim()) continue;
        const why = invisibleWhy(s, view, painted);
        if (!why) {
          visibleRuns++;
          continue;
        }
        onPage.push({
          page_no: n,
          reason: why.reason,
          text: text.trim(),
          detail: why.detail,
          in_extracted: normalise(extracted).includes(normalise(text)),
        });
      }
    }
    out.push(...settle(onPage, visibleRuns, sawImage, n));
  }
  return out;
}

/**
 * A scanned page that has been through OCR carries its whole text layer in rendering mode 3, under
 * the picture. **That is the honest use of the same mechanism an injection uses**, and without this
 * function every line of every scanned packet would be marked as hidden. A disclosure that fires on
 * every line of an ordinary scan is one the reader stops reading on the first packet, which is the same
 * failure as a false positive and costs more, because it arrives in bulk.
 *
 * The rule: a page whose text is ENTIRELY invisible, and which paints an image, is a scan with an
 * OCR layer. An injection hides text AMONG visible text; a scan has no visible text to hide among.
 * Such a page reports one row saying what it is, instead of one row per line.
 *
 * What that costs, stated because it is a real hole: a page that is nothing but an injection over a
 * picture, with no visible text at all, reads as an OCR layer. It is narrow and it is a miss.
 */
function settle(onPage: HiddenRun[], visibleRuns: number, sawImage: boolean, pageNo: number): HiddenRun[] {
  const invisible = onPage.filter((r) => r.reason === "invisible");
  const isScan = invisible.length > 0 && invisible.length === onPage.length && visibleRuns === 0 && sawImage;
  if (!isScan) return onPage;
  return [
    {
      page_no: pageNo,
      reason: "ocr-layer",
      text: invisible.map((r) => r.text).join(" ").slice(0, 400),
      detail:
        `every one of the ${invisible.length} text run(s) on this page is invisible and the page paints an image, ` +
        `which is a scan with an OCR layer under it rather than text hidden among visible prose`,
      in_extracted: invisible.some((r) => r.in_extracted),
    },
  ];
}

function invisibleWhy(s: State, view: number[], painted: Box[]): { reason: HiddenRun["reason"]; detail: string } | null {
  const [px, py] = apply(s.ctm, s.x, s.y);
  const drawn = s.size * s.tmScale * scaleOf(s.ctm);
  // Mode 3 paints nothing; mode 7 adds to the clipping path and paints nothing.
  if (s.mode === 3 || s.mode === 7) {
    return { reason: "invisible", detail: `text rendering mode ${s.mode}, which places glyphs and paints none` };
  }
  const onShape = painted.some((b) => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1);
  if (isWhite(s.fill) && !onShape) {
    return { reason: "white", detail: `fill colour rgb(${s.fill.join(",")}), which is the colour of the paper` };
  }
  if (drawn > 0 && drawn < TINY_POINTS) {
    return { reason: "tiny", detail: `${Math.round(drawn * 10) / 10}pt as drawn, under the ${TINY_POINTS}pt floor` };
  }
  const [x0, y0, x1, y1] = [view[0] ?? 0, view[1] ?? 0, view[2] ?? 0, view[3] ?? 0];
  if (px < x0 || px > x1 || py < y0 || py > y1) {
    return { reason: "offpage", detail: `drawn at (${Math.round(px)}, ${Math.round(py)}), outside the page` };
  }
  return null;
}

/** pdf.js hands showText an array of glyph objects, or a width adjustment as a bare number. */
function glyphs(arg: unknown): string {
  if (!Array.isArray(arg)) return "";
  let out = "";
  for (const g of arg) {
    if (g == null) continue;
    if (typeof g === "number") continue; // kerning, not a character
    const u = (g as any).unicode;
    if (typeof u === "string") out += u;
  }
  return out;
}

const normalise = (s: string) => s.replace(/\s+/g, " ").toLowerCase().trim();
