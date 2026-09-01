import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import JSZip from "jszip";

// Restyles native tables inside a PPTX produced by the vendored native-pptx exporter
// (vendor/marp-to-editable-pptx) to match deckd's theme. The exporter emits every
// table cell with a full 1pt grid and zero row heights; the theme's own tables have
// no vertical borders -- a 2pt Ink rule under the header row, and a 1pt Grey Light
// rule under every body row -- so this rewrites those border properties in place and
// grows the table's graphic frame to the summed row heights it applies, so a table
// isn't left declared at PowerPoint's 1in default. TypeScript port of the
// presentations repo's tools/fix_pptx_tables.py (spec decision 1: zero Python).

const INK = "1D1C30";
const GREY_LIGHT = "EAEAF1";
// 0.45in per row, matching 10px padding + 16pt text (EMU: 914400 per inch).
const ROW_HEIGHT_EMU = 411480;

const SLIDE_XML_RE = /^ppt\/slides\/slide\d+\.xml$/;

function noLineXml(tag: string): string {
  return `<a:${tag} w="12700"><a:noFill/></a:${tag}>`;
}

function bottomLineXml(width: number, color: string): string {
  return `<a:lnB w="${width}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:lnB>`;
}

// Replaces only the first occurrence of `needle` in `haystack` with the literal text
// `replacement` -- like Python's str.replace(a, b, 1) -- without String.replace's
// "$&"/"$1" substitution patterns kicking in if the XML text ever contains a "$".
function replaceFirstLiteral(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

// Strips a cell's left/right/top borders (the exporter's full grid) and sets its
// bottom rule to the theme's header- or body-row style.
function restyleCell(cell: string, header: boolean): string {
  let result = cell;
  for (const tag of ["lnL", "lnR", "lnT"]) {
    result = result.replace(new RegExp(`<a:${tag}\\b[\\s\\S]*?</a:${tag}>`, "g"), noLineXml(tag));
  }
  const bottom = header ? bottomLineXml(25400, INK) : bottomLineXml(12700, GREY_LIGHT);
  result = result.replace(/<a:lnB\b[\s\S]*?<\/a:lnB>/g, bottom);
  return result;
}

// Restyles every row/cell in one <a:tbl>...</a:tbl> block: the first row (header)
// gets the thicker Ink rule, every other row gets the thin Grey Light rule, and
// every row's declared height is normalized to ROW_HEIGHT_EMU.
function restyleTable(tblXml: string): string {
  let tbl = tblXml;
  const rows = tblXml.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? [];
  rows.forEach((row, i) => {
    let newRow = row.replace(/(<a:tr) h="\d+"/, `$1 h="${ROW_HEIGHT_EMU}"`);
    const cells = newRow.match(/<a:tc>[\s\S]*?<\/a:tc>/g) ?? [];
    for (const cell of cells) {
      newRow = replaceFirstLiteral(newRow, cell, restyleCell(cell, i === 0));
    }
    tbl = replaceFirstLiteral(tbl, row, newRow);
  });
  return tbl;
}

export interface FixSlideResult {
  xml: string;
  tableCount: number;
}

// Restyles every table in one slide's XML, then grows the FIRST graphic frame found
// in the slide to the row-height total of the FIRST table only -- matching the
// original script's behavior: a slide with more than one table still has just its
// first table's row count applied to the (also first) graphic frame's height.
export function fixSlideXml(xml: string): FixSlideResult {
  let result = xml;
  const tables = xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/g) ?? [];
  for (const tbl of tables) {
    result = replaceFirstLiteral(result, tbl, restyleTable(tbl));
  }
  if (tables.length > 0) {
    const firstTable = tables[0] ?? "";
    const rowCount = (firstTable.match(/<a:tr\b/g) ?? []).length;
    const total = rowCount * ROW_HEIGHT_EMU;
    const frameExtRe = /(<p:graphicFrame>[\s\S]*?<a:ext cx="\d+" cy=")\d+(")/;
    result = result.replace(frameExtRe, (_m, before: string, after: string) => `${before}${total}${after}`);
  }
  return { xml: result, tableCount: tables.length };
}

export interface FixPptxTablesResult {
  tablesFixed: number;
}

async function fixPptxTablesInner(pptxPath: string): Promise<FixPptxTablesResult> {
  const original = await readFile(pptxPath);
  const zip = await JSZip.loadAsync(original);

  let tablesFixed = 0;
  for (const name of Object.keys(zip.files)) {
    if (!SLIDE_XML_RE.test(name)) continue;
    const file = zip.file(name);
    if (file === null) continue;
    const xml = await file.async("string");
    const { xml: newXml, tableCount } = fixSlideXml(xml);
    tablesFixed += tableCount;
    if (tableCount > 0) zip.file(name, newXml);
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const tmpPath = `${pptxPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, buffer);
  try {
    await rename(tmpPath, pptxPath);
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    throw e;
  }

  return { tablesFixed };
}

// Rewrites every ppt/slides/slideN.xml entry in the pptx at `pptxPath` in place,
// restyling any native table the vendored exporter produced. Writes to a temp file
// beside the original and renames it over, so a crash mid-write never leaves a
// partially-written pptx at `pptxPath`.
//
// deadlineAt, when given, is the render job's own shared deadline (see
// host-render.ts's renderPptxArtifact) -- this step runs after marp and gen-pptx
// have already spent part of that budget. The work here is CPU-bound zip/XML
// manipulation on a single small file, not I/O that can hang indefinitely, so a
// pre-check plus a Promise.race is enough: it rejects immediately if the deadline
// has already passed (rather than starting work that can't finish in time), and
// still bounds a pathological case (e.g. a corrupted pptx that sends jszip into a
// slow decompression path) to whatever's left of the shared budget instead of
// running unbounded.
export async function fixPptxTables(pptxPath: string, deadlineAt?: number): Promise<FixPptxTablesResult> {
  if (deadlineAt === undefined) return fixPptxTablesInner(pptxPath);

  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error(`fixPptxTables: deadline already passed (${-remaining}ms ago)`);
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fixPptxTablesInner(pptxPath),
      new Promise<FixPptxTablesResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fixPptxTables: exceeded its deadline (${remaining}ms budget)`)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
