import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { fixSlideXml, fixPptxTables, pruneOrphanedContentTypeOverrides } from "../src/pptx-table-fix.js";

// Mirrors the shape the vendored native-pptx exporter emits: every cell carries a
// full 1pt (12700 EMU) grid on all four sides, and every row is declared h="0".
function unfixedCell(text: string): string {
  return `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr>` +
    `<a:lnL w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnL>` +
    `<a:lnR w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnR>` +
    `<a:lnT w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnT>` +
    `<a:lnB w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnB>` +
    `</a:tcPr></a:tc>`;
}

function unfixedRow(...cells: string[]): string {
  return `<a:tr h="0">${cells.map(unfixedCell).join("")}</a:tr>`;
}

function unfixedTable(rows: string): string {
  return `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1000"/></a:tblGrid>${rows}</a:tbl>`;
}

function slideWithFrame(tableXml: string, cy = 914400): string {
  return (
    `<p:sld><p:cSld><p:spTree>` +
    `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="${cy}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `${tableXml}</a:graphicData></a:graphic></p:graphicFrame>` +
    `</p:spTree></p:cSld></p:sld>`
  );
}

describe("fixSlideXml", () => {
  it("returns the xml unchanged and tableCount 0 when there is no table", () => {
    const xml = "<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>";
    const result = fixSlideXml(xml);
    expect(result.xml).toBe(xml);
    expect(result.tableCount).toBe(0);
  });

  it("strips left/right/top borders and sets the header row's bottom rule to the 2pt Ink line", () => {
    const table = unfixedTable(unfixedRow("Header"));
    const xml = slideWithFrame(table);
    const { xml: fixed, tableCount } = fixSlideXml(xml);

    expect(tableCount).toBe(1);
    expect(fixed).toContain('<a:lnL w="12700"><a:noFill/></a:lnL>');
    expect(fixed).toContain('<a:lnR w="12700"><a:noFill/></a:lnR>');
    expect(fixed).toContain('<a:lnT w="12700"><a:noFill/></a:lnT>');
    expect(fixed).toContain(
      '<a:lnB w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="1D1C30"/></a:solidFill></a:lnB>',
    );
    // The header row's bottom rule must not be the body-row (Grey Light) style.
    expect(fixed).not.toContain("EAEAF1");
  });

  it("sets a body row's bottom rule to the 1pt Grey Light line, distinct from the header", () => {
    const table = unfixedTable(unfixedRow("Header") + unfixedRow("Body"));
    const { xml: fixed } = fixSlideXml(slideWithFrame(table));

    expect(fixed).toContain(
      '<a:lnB w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="1D1C30"/></a:solidFill></a:lnB>',
    );
    expect(fixed).toContain(
      '<a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="EAEAF1"/></a:solidFill></a:lnB>',
    );
  });

  it("normalizes every row's height to the fixed row-height EMU value", () => {
    const table = unfixedTable(unfixedRow("Header") + unfixedRow("Body"));
    const { xml: fixed } = fixSlideXml(slideWithFrame(table));

    expect(fixed).not.toContain('h="0"');
    expect((fixed.match(/<a:tr h="411480">/g) ?? []).length).toBe(2);
  });

  it("grows the graphic frame's cy to the summed row heights of the table", () => {
    const table = unfixedTable(unfixedRow("Header") + unfixedRow("Body") + unfixedRow("Body2"));
    const { xml: fixed } = fixSlideXml(slideWithFrame(table, /* cy */ 1));

    // 3 rows * 411480 EMU/row.
    expect(fixed).toContain('<a:ext cx="9144000" cy="1234440"/>');
  });

  it("uses only the first table's row count for the frame height when a slide has two tables", () => {
    const first = unfixedTable(unfixedRow("A"));
    const second = unfixedTable(unfixedRow("B") + unfixedRow("C"));
    const xml = slideWithFrame(first + second, 1);
    const { xml: fixed, tableCount } = fixSlideXml(xml);

    expect(tableCount).toBe(2);
    // Only the first (single-row) table's height is applied to the (single, first)
    // graphic frame -- 1 * 411480, not 3 * 411480.
    expect(fixed).toContain('<a:ext cx="9144000" cy="411480"/>');
    // Both tables are still individually restyled.
    expect((fixed.match(/<a:tr h="411480">/g) ?? []).length).toBe(3);
  });
});

describe("pruneOrphanedContentTypeOverrides", () => {
  it("removes an Override whose PartName has no matching zip entry", () => {
    const xml =
      '<Types><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>';
    const actualPartNames = new Set(["ppt/slideMasters/slideMaster1.xml"]);

    const { xml: pruned, removed } = pruneOrphanedContentTypeOverrides(xml, actualPartNames);

    expect(removed).toBe(1);
    expect(pruned).toContain('PartName="/ppt/slideMasters/slideMaster1.xml"');
    expect(pruned).not.toContain("slideMaster2.xml");
  });

  it("keeps every Override when all declared parts exist", () => {
    const xml = '<Types><Override PartName="/ppt/presentation.xml" ContentType="x"/></Types>';
    const actualPartNames = new Set(["ppt/presentation.xml"]);

    const { xml: pruned, removed } = pruneOrphanedContentTypeOverrides(xml, actualPartNames);

    expect(removed).toBe(0);
    expect(pruned).toBe(xml);
  });

  it("leaves Default (extension-based) entries alone -- only Override is part-specific", () => {
    const xml = '<Types><Default Extension="png" ContentType="image/png"/></Types>';
    const { xml: pruned, removed } = pruneOrphanedContentTypeOverrides(xml, new Set());

    expect(removed).toBe(0);
    expect(pruned).toBe(xml);
  });
});

describe("fixPptxTables", () => {
  // Reproduces the actual defect (github.com/gitbrent/PptxGenJS/issues/1449): a
  // 2-slide deck sharing one slide master, whose Content_Types.xml declares an
  // Override for both slideMaster1.xml (real) and slideMaster2.xml (never written,
  // since pptxgenjs's own Content_Types generator loops per-slide, not per-master).
  it("prunes an orphaned slideMaster Override left by the exporter's Content_Types bug", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-pptx-fixture-"));
    const pptxPath = join(dir, "deck-editable.pptx");
    const contentTypes =
      '<Types><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>';
    const plainSlideXml = "<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>";

    const zip = new JSZip();
    zip.file("[Content_Types].xml", contentTypes);
    zip.file("ppt/slides/slide1.xml", plainSlideXml);
    zip.file("ppt/slides/slide2.xml", plainSlideXml);
    zip.file("ppt/slideMasters/slideMaster1.xml", "<p:sldMaster/>");
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await fixPptxTables(pptxPath);
    expect(result.orphanedContentTypeOverridesRemoved).toBe(1);

    const rewritten = await JSZip.loadAsync(await readFile(pptxPath));
    const rewrittenContentTypes = await rewritten.file("[Content_Types].xml")?.async("string");
    expect(rewrittenContentTypes).not.toContain("slideMaster2.xml");
    // The real master's own Override, and the unrelated slide Overrides, survive.
    expect(rewrittenContentTypes).toContain('PartName="/ppt/slideMasters/slideMaster1.xml"');
    expect(rewrittenContentTypes).toContain('PartName="/ppt/slides/slide1.xml"');
    expect(rewrittenContentTypes).toContain('PartName="/ppt/slides/slide2.xml"');
  });

  it("restyles only ppt/slides/slideN.xml entries, leaving other zip entries untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-pptx-fixture-"));
    const pptxPath = join(dir, "deck-editable.pptx");

    const zip = new JSZip();
    const tableSlideXml = slideWithFrame(unfixedTable(unfixedRow("Header") + unfixedRow("Body")));
    const plainSlideXml = "<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>";
    // Not a slide -- must survive unmodified even though it contains the exact same
    // "<a:tbl>" text a slide's table would (a layout can carry a template table too).
    const layoutXml = slideWithFrame(unfixedTable(unfixedRow("Layout placeholder")));

    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("ppt/slides/slide1.xml", tableSlideXml);
    zip.file("ppt/slides/slide2.xml", plainSlideXml);
    zip.file("ppt/slideLayouts/slideLayout1.xml", layoutXml);
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(pptxPath, buf);

    const result = await fixPptxTables(pptxPath);
    expect(result.tablesFixed).toBe(1);
    expect(result.orphanedContentTypeOverridesRemoved).toBe(0);

    const rewritten = await JSZip.loadAsync(await readFile(pptxPath));
    const slide1 = await rewritten.file("ppt/slides/slide1.xml")?.async("string");
    const slide2 = await rewritten.file("ppt/slides/slide2.xml")?.async("string");
    const layout = await rewritten.file("ppt/slideLayouts/slideLayout1.xml")?.async("string");
    const contentTypes = await rewritten.file("[Content_Types].xml")?.async("string");

    expect(slide1).toContain('<a:lnL w="12700"><a:noFill/></a:lnL>');
    expect(slide1).toContain("1D1C30");
    expect(slide2).toBe(plainSlideXml);
    // The layout's own identical-looking table must be left exactly as it was.
    expect(layout).toBe(layoutXml);
    expect(contentTypes).toBe("<Types/>");
  });

  it("returns tablesFixed 0 and rewrites nothing when no slide has a table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-pptx-fixture-"));
    const pptxPath = join(dir, "deck-editable.pptx");
    const plainSlideXml = "<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>";

    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", plainSlideXml);
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await fixPptxTables(pptxPath);
    expect(result.tablesFixed).toBe(0);

    const rewritten = await JSZip.loadAsync(await readFile(pptxPath));
    expect(await rewritten.file("ppt/slides/slide1.xml")?.async("string")).toBe(plainSlideXml);
  });

  // B2: fixPptxTables gets the render job's own shared deadline, so a corrupted
  // gen-pptx output (or a pathologically slow one) can't run past whatever's left
  // of the job's overall timeout.
  describe("deadline", () => {
    it("rejects immediately, without touching the file, when the deadline has already passed", async () => {
      const dir = mkdtempSync(join(tmpdir(), "deckd-pptx-fixture-"));
      const pptxPath = join(dir, "deck-editable.pptx");
      const zip = new JSZip();
      zip.file("ppt/slides/slide1.xml", slideWithFrame(unfixedTable(unfixedRow("Header"))));
      const original = await zip.generateAsync({ type: "nodebuffer" });
      await writeFile(pptxPath, original);

      const started = Date.now();
      await expect(fixPptxTables(pptxPath, Date.now() - 1)).rejects.toThrow(/deadline already passed/);
      expect(Date.now() - started).toBeLessThan(200);
      // Rejecting before starting means the file is untouched -- still the original
      // unfixed bytes, not a half-written temp file left over.
      expect(await readFile(pptxPath)).toEqual(original);
    });

    it("still succeeds when the deadline has plenty of budget left", async () => {
      const dir = mkdtempSync(join(tmpdir(), "deckd-pptx-fixture-"));
      const pptxPath = join(dir, "deck-editable.pptx");
      const zip = new JSZip();
      zip.file("ppt/slides/slide1.xml", slideWithFrame(unfixedTable(unfixedRow("Header"))));
      await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));

      const result = await fixPptxTables(pptxPath, Date.now() + 30_000);
      expect(result.tablesFixed).toBe(1);
    });

    // Also covers the corrupted-pptx nit: a non-zip file must fail fast with a
    // clear error (JSZip's own "corrupted zip" message), not hang until a caller's
    // timeout elsewhere is the only thing that notices.
    it("throws promptly with a clear error for a corrupted/non-zip pptx, deadline or not", async () => {
      const dir = mkdtempSync(join(tmpdir(), "deckd-pptx-fixture-"));
      const pptxPath = join(dir, "not-a-zip.pptx");
      await writeFile(pptxPath, "this is not a zip file at all");

      const started = Date.now();
      await expect(fixPptxTables(pptxPath, Date.now() + 30_000)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });
});
