"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/native-pptx/index.ts
var index_exports = {};
__export(index_exports, {
  generateNativePptx: () => generateNativePptx
});
module.exports = __toCommonJS(index_exports);
var import_promises = require("node:fs/promises");
var import_node_url2 = require("node:url");
var import_puppeteer_core = __toESM(require("puppeteer-core"));

// src/native-pptx/dom-walker-script.generated.ts
var DOM_WALKER_SCRIPT = '"use strict";\nvar DomWalker = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // src/native-pptx/dom-walker.ts\n  var dom_walker_exports = {};\n  __export(dom_walker_exports, {\n    extractSlides: () => extractSlides\n  });\n  function extractSlides(root = document) {\n    function findBackgroundColor(section) {\n      const style = getComputedStyle(section);\n      const bg = style.backgroundColor;\n      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {\n        return bg;\n      }\n      const bgImage = style.backgroundImage;\n      if (bgImage && bgImage !== "none") {\n        const colorMatches = bgImage.match(\n          /rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*[\\d.]+)?\\s*\\)/g\n        );\n        if (colorMatches && colorMatches.length > 0) {\n          for (let i = colorMatches.length - 1; i >= 0; i--) {\n            const c = colorMatches[i];\n            if (c !== "rgba(0, 0, 0, 0)") {\n              const alphaMatch = c.match(\n                /rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)/\n              );\n              if (!alphaMatch || parseFloat(alphaMatch[1]) > 0.1) {\n                return c;\n              }\n            }\n          }\n        }\n      }\n      return "rgb(255, 255, 255)";\n    }\n    function extractTextStyle(style) {\n      let textAlign = style.textAlign || "left";\n      if (textAlign === "start") textAlign = "left";\n      else if (textAlign === "end") textAlign = "right";\n      if (textAlign === "left" && style.justifyContent === "center")\n        textAlign = "center";\n      return {\n        color: style.color,\n        fontSize: parseFloat(style.fontSize) || 16,\n        fontFamily: style.fontFamily,\n        fontWeight: parseInt(style.fontWeight, 10) || 400,\n        textAlign,\n        lineHeight: parseFloat(style.lineHeight) || 0,\n        letterSpacing: parseFloat(style.letterSpacing) || 0,\n        ...style.whiteSpace === "nowrap" ? { whiteSpace: "nowrap" } : {}\n      };\n    }\n    function isSemanticInlineHighlightTag(tag) {\n      return tag === "strong" || tag === "mark" || tag === "code";\n    }\n    function extractEffectiveBg(elStyle) {\n      const bg = elStyle.backgroundColor;\n      const hasBg = !!bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)";\n      if (hasBg) {\n        const alphaMatch = bg.match(/,\\s*([\\d.]+)\\s*\\)$/);\n        if (!alphaMatch || parseFloat(alphaMatch[1]) !== 0) return bg;\n      }\n      const bi = elStyle.backgroundImage;\n      if (!bi || bi === "none" || !bi.includes("linear-gradient")) return void 0;\n      const colorMatches = bi.match(/rgba?\\([^)]+\\)/g);\n      if (!colorMatches || colorMatches.length === 0) return void 0;\n      for (let ci = colorMatches.length - 1; ci >= 0; ci--) {\n        const c = colorMatches[ci];\n        if (c !== "rgba(0, 0, 0, 0)" && c !== "rgba(0,0,0,0)" && !/rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0\\s*\\)/.test(c)) {\n          return c;\n        }\n      }\n      return void 0;\n    }\n    function isEmojiImg(imgEl) {\n      const alt = imgEl.alt ?? "";\n      return !!(imgEl.classList?.contains("emoji") || imgEl.src && (imgEl.src.includes("twemoji") || imgEl.src.includes("/emoji/")) || alt.length > 0 && alt.length <= 8 && /\\p{Extended_Pictographic}/u.test(alt));\n    }\n    function extractTextRuns(element, skipInlineBadges = false, stripBgBadges = false, skipBlockEls = false) {\n      const runs = [];\n      const elementStyle = getComputedStyle(element);\n      const elementBg = elementStyle.backgroundColor;\n      const elementHasBg = !!elementBg && elementBg !== "transparent" && elementBg !== "rgba(0, 0, 0, 0)";\n      function lastIsBreak() {\n        return runs.length > 0 && runs[runs.length - 1].breakLine === true;\n      }\n      function pushText(text, style, bg) {\n        const segments = text.split("\\n");\n        for (let i = 0; i < segments.length; i++) {\n          const seg = segments[i];\n          if (seg !== "") {\n            const run = {\n              text: seg,\n              color: style.color,\n              fontSize: parseFloat(style.fontSize) || 16,\n              fontFamily: style.fontFamily,\n              bold: parseInt(style.fontWeight, 10) >= 600,\n              italic: style.fontStyle === "italic",\n              underline: style.textDecorationLine?.includes("underline"),\n              strikethrough: style.textDecorationLine?.includes("line-through")\n            };\n            if (bg) run.backgroundColor = bg;\n            runs.push(run);\n          }\n          if (i < segments.length - 1 && !lastIsBreak()) {\n            runs.push({ text: "", breakLine: true });\n          }\n        }\n      }\n      for (const node of Array.from(element.childNodes)) {\n        if (node.nodeType === Node.TEXT_NODE) {\n          const text = node.textContent ?? "";\n          if (text.trim() === "") {\n            const newlineCount = (text.match(/\\n/g) ?? []).length;\n            for (let i = 0; i < newlineCount; i++) {\n              if (!lastIsBreak()) runs.push({ text: "", breakLine: true });\n            }\n            if (newlineCount === 0 && text.length > 0 && !lastIsBreak()) {\n              const ws = elementStyle.whiteSpace;\n              const preserve = ws === "pre" || ws === "pre-wrap" || ws === "break-spaces";\n              pushText(preserve ? text : " ", elementStyle, elementHasBg ? elementBg : void 0);\n            }\n            continue;\n          }\n          pushText(text, elementStyle, elementHasBg ? elementBg : void 0);\n        } else if (node.nodeType === Node.ELEMENT_NODE) {\n          const el = node;\n          const tag = el.tagName.toLowerCase();\n          if (tag === "br") {\n            if (!lastIsBreak()) runs.push({ text: "", breakLine: true });\n            continue;\n          }\n          if (el.classList?.contains("katex-mathml")) continue;\n          if (tag === "mjx-container" || tag === "svg") continue;\n          if (tag === "sub" || tag === "sup") {\n            const childRuns = extractTextRuns(el, skipInlineBadges, stripBgBadges);\n            const flag = tag === "sub" ? "subscript" : "superscript";\n            childRuns.forEach((r) => {\n              if (!r.breakLine) r[flag] = true;\n            });\n            runs.push(...childRuns);\n            continue;\n          }\n          if (tag === "a") {\n            const href = el.href;\n            const childRuns = extractTextRuns(el);\n            childRuns.forEach((r) => {\n              if (!r.breakLine) r.hyperlink = href;\n            });\n            runs.push(...childRuns);\n            continue;\n          }\n          if (tag === "img") {\n            const imgEl = el;\n            const alt = imgEl.alt ?? "";\n            if (isEmojiImg(imgEl) && alt) {\n              pushText(alt, getComputedStyle(el), void 0);\n            }\n            continue;\n          }\n          const elStyle = getComputedStyle(el);\n          if (/^(block|flex|grid|list-item|table)/.test(elStyle.display)) {\n            if (skipBlockEls instanceof Set && skipBlockEls.has(el)) continue;\n            if (!lastIsBreak() && runs.length > 0) {\n              runs.push({ text: "", breakLine: true });\n            }\n            runs.push(...extractTextRuns(el));\n          } else {\n            const bg = elStyle.backgroundColor;\n            const hasBg = bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)";\n            const alphaZero = hasBg && (() => {\n              const m = bg.match(/,\\s*([\\d.]+)\\s*\\)$/);\n              return m ? parseFloat(m[1]) === 0 : false;\n            })();\n            const effectiveBg = extractEffectiveBg(elStyle);\n            const inlineElBorderRadius = parseFloat(elStyle.borderRadius) || 0;\n            const inlineTag = el.tagName.toLowerCase();\n            const isSemanticInlineHighlight = isSemanticInlineHighlightTag(inlineTag);\n            const isInlineEligibleBadge = (() => {\n              if (isSemanticInlineHighlight) return false;\n              if (elStyle.display !== "inline") return false;\n              if (inlineTag !== "span") return false;\n              if (inlineElBorderRadius <= 0) return false;\n              const m = (effectiveBg ?? "").match(/,\\s*([\\d.]+)\\s*\\)$/);\n              return m ? parseFloat(m[1]) >= 0.5 : true;\n            })();\n            const isInlineBadgeDisplay = !isSemanticInlineHighlight && (elStyle.display === "inline-block" || elStyle.display === "inline-flex" || elStyle.display === "inline-grid");\n            const isBadge = effectiveBg && !alphaZero && (isInlineBadgeDisplay || isInlineEligibleBadge);\n            if (isBadge) {\n              const shouldSkipBadge = skipInlineBadges === true || skipInlineBadges instanceof Set && skipInlineBadges.has(el);\n              if (shouldSkipBadge) {\n                continue;\n              }\n              const shouldStripBg = stripBgBadges instanceof Set && stripBgBadges.has(el);\n              const childRuns2 = extractTextRuns(el, false);\n              if (shouldStripBg) {\n                childRuns2.forEach((r) => {\n                  if (!r.breakLine) r.backgroundColor = void 0;\n                });\n              } else {\n                childRuns2.forEach((r) => {\n                  if (!r.breakLine && !r.backgroundColor) r.backgroundColor = effectiveBg;\n                });\n              }\n              runs.push(...childRuns2);\n              continue;\n            }\n            const childRuns = extractTextRuns(el, skipInlineBadges, stripBgBadges);\n            if (effectiveBg) {\n              childRuns.forEach((r) => {\n                if (!r.breakLine && !r.backgroundColor) r.backgroundColor = effectiveBg;\n              });\n            }\n            runs.push(...childRuns);\n          }\n        }\n      }\n      while (runs.length > 0 && runs[runs.length - 1].breakLine) {\n        runs.pop();\n      }\n      while (runs.length > 0 && runs[0].breakLine) {\n        runs.shift();\n      }\n      return runs;\n    }\n    function computeLeadingOffset(badgeShapes, containerRect, slideRect) {\n      if (badgeShapes.length === 0) return 0;\n      const containerSSLeft = containerRect.left - slideRect.left;\n      const leading = badgeShapes.filter((b) => {\n        if (b.x > containerSSLeft + 8) return false;\n        const runs = b.runs;\n        return Array.isArray(runs) && runs.length > 0;\n      });\n      if (leading.length === 0) return 0;\n      const rightEdge = leading.reduce(\n        (max, b) => Math.max(max, b.x + b.width),\n        containerSSLeft\n      );\n      return Math.max(0, rightEdge - containerSSLeft);\n    }\n    function computeShallowFlexOffset(container, containerRect, slideRect, style) {\n      const containerSSLeft = containerRect.left - slideRect.left;\n      const containerGap = parseFloat(style.columnGap || style.gap || "0") || 0;\n      for (const node of Array.from(container.childNodes)) {\n        if (node.nodeType === Node.TEXT_NODE) {\n          if ((node.textContent ?? "").trim() !== "") return 0;\n          continue;\n        }\n        if (node.nodeType !== Node.ELEMENT_NODE) continue;\n        const nodeEl = node;\n        const nodeStyle = getComputedStyle(nodeEl);\n        if (nodeStyle.display === "none" || nodeStyle.visibility === "hidden") {\n          continue;\n        }\n        const nodeRect = nodeEl.getBoundingClientRect();\n        if (nodeRect.width <= 0 || nodeRect.height <= 0) continue;\n        return Math.max(0, nodeRect.right - slideRect.left - containerSSLeft) + containerGap;\n      }\n      return 0;\n    }\n    function extractListItemEl(li, level = 0, skipBadges = false, stripBadges = false, leadingOffsetPx = 0) {\n      const items = [];\n      const runs = [];\n      const nestedItems = [];\n      function lastIsBreak() {\n        return runs.length > 0 && runs[runs.length - 1].breakLine === true;\n      }\n      for (const node of Array.from(li.childNodes)) {\n        if (node.nodeType === Node.TEXT_NODE) {\n          const text = node.textContent ?? "";\n          if (text.trim() === "") continue;\n          const liStyle = getComputedStyle(li);\n          const liBg = liStyle.backgroundColor;\n          const liHasBg = !!liBg && liBg !== "transparent" && liBg !== "rgba(0, 0, 0, 0)";\n          const segments = text.split("\\n");\n          for (let i = 0; i < segments.length; i++) {\n            const seg = segments[i];\n            if (seg !== "") {\n              const run = {\n                text: seg,\n                color: liStyle.color,\n                fontSize: parseFloat(liStyle.fontSize) || 16,\n                fontFamily: liStyle.fontFamily,\n                bold: parseInt(liStyle.fontWeight, 10) >= 600,\n                italic: liStyle.fontStyle === "italic"\n              };\n              if (liHasBg) run.backgroundColor = liBg;\n              runs.push(run);\n            }\n            if (i < segments.length - 1) {\n              if (!lastIsBreak()) runs.push({ text: "", breakLine: true });\n            }\n          }\n        } else if (node.nodeType === Node.ELEMENT_NODE) {\n          const el = node;\n          const childTag = el.tagName.toLowerCase();\n          if (childTag === "ul" || childTag === "ol") {\n            nestedItems.push(...extractListItems(el, level + 1));\n          } else if (childTag === "br") {\n            if (!lastIsBreak()) runs.push({ text: "", breakLine: true });\n          } else if (childTag === "img") {\n            const imgEl = el;\n            const alt = imgEl.alt ?? "";\n            if (isEmojiImg(imgEl) && alt) {\n              const liStyle = getComputedStyle(li);\n              runs.push({\n                text: alt,\n                color: liStyle.color,\n                fontSize: parseFloat(liStyle.fontSize) || 16,\n                fontFamily: liStyle.fontFamily,\n                bold: parseInt(liStyle.fontWeight, 10) >= 600,\n                italic: liStyle.fontStyle === "italic"\n              });\n            }\n          } else if (childTag === "sub" || childTag === "sup") {\n            const childRuns = extractTextRuns(el, skipBadges, stripBadges);\n            const flag = childTag === "sub" ? "subscript" : "superscript";\n            childRuns.forEach((r) => {\n              if (!r.breakLine) r[flag] = true;\n            });\n            runs.push(...childRuns);\n          } else {\n            if (skipBadges !== false && skipBadges.has(el)) continue;\n            const isBlockChild = /^(p|div|blockquote|pre|figure|h[1-6]|section|article|aside|header|footer|main)$/.test(childTag);\n            if (isBlockChild && runs.length > 0 && !lastIsBreak()) {\n              runs.push({ text: "", breakLine: true });\n            }\n            if (childTag === "pre" || childTag === "marp-pre") {\n              continue;\n            }\n            const childRuns = extractTextRuns(el, skipBadges, stripBadges);\n            if (stripBadges instanceof Set && stripBadges.has(el)) {\n              childRuns.forEach((r) => {\n                if (!r.breakLine) r.backgroundColor = void 0;\n              });\n            } else if (!isBlockChild) {\n              const elBg = extractEffectiveBg(getComputedStyle(el));\n              if (elBg) {\n                childRuns.forEach((r) => {\n                  if (!r.breakLine && !r.backgroundColor) r.backgroundColor = elBg;\n                });\n              }\n            }\n            runs.push(...childRuns);\n          }\n        }\n      }\n      if (runs.length > 0) {\n        const combinedText = runs.map((r) => r.text).join("");\n        const liStyle = getComputedStyle(li);\n        items.push({\n          text: combinedText.trim(),\n          level,\n          listStyleType: liStyle.listStyleType || void 0,\n          runs,\n          ...leadingOffsetPx > 0 ? { leadingOffset: leadingOffsetPx } : {}\n        });\n      }\n      items.push(...nestedItems);\n      return items;\n    }\n    function extractListItems(list, level = 0, perLiSkipMap, perLiStripMap, perLiLeadingOffsetMap) {\n      const items = [];\n      for (const child of Array.from(list.children)) {\n        if (child.tagName.toLowerCase() === "li") {\n          const skipBadges = perLiSkipMap?.get(child) ?? false;\n          const stripBadges = perLiStripMap?.get(child) ?? false;\n          const leadingOffsetPx = perLiLeadingOffsetMap?.get(child) ?? 0;\n          items.push(\n            ...extractListItemEl(\n              child,\n              level,\n              skipBadges,\n              stripBadges,\n              leadingOffsetPx\n            )\n          );\n        }\n      }\n      return items;\n    }\n    function extractCodeRuns(codeEl) {\n      const runs = [];\n      const defaultStyle = getComputedStyle(codeEl);\n      function lastIsBreak() {\n        return runs.length > 0 && runs[runs.length - 1].breakLine === true;\n      }\n      function walk(node) {\n        if (node.nodeType === Node.TEXT_NODE) {\n          const text = node.textContent ?? "";\n          if (text === "") return;\n          const parent = node.parentElement ?? codeEl;\n          const style = getComputedStyle(parent);\n          const segments = text.split("\\n");\n          for (let i = 0; i < segments.length; i++) {\n            const seg = segments[i];\n            if (seg !== "") {\n              runs.push({\n                text: seg,\n                color: style.color,\n                fontSize: parseFloat(style.fontSize) || parseFloat(defaultStyle.fontSize) || 16,\n                fontFamily: style.fontFamily || defaultStyle.fontFamily,\n                bold: parseInt(style.fontWeight, 10) >= 600,\n                italic: style.fontStyle === "italic"\n              });\n            }\n            if (i < segments.length - 1) {\n              runs.push({ text: "", breakLine: true });\n            }\n          }\n        } else if (node.nodeType === Node.ELEMENT_NODE) {\n          for (const child of Array.from(node.childNodes)) {\n            walk(child);\n          }\n        }\n      }\n      walk(codeEl);\n      return runs;\n    }\n    function computeAutoScaleFactor(runs, preStyle, rectHeight) {\n      const lineHeight = parseFloat(preStyle.lineHeight) || 0;\n      if (lineHeight <= 0 || rectHeight <= 0) return 1;\n      const lineBreaks = runs.filter((r) => r.breakLine).length;\n      const numLines = lineBreaks + 1;\n      const paddingTop = parseFloat(preStyle.paddingTop) || 0;\n      const paddingBottom = parseFloat(preStyle.paddingBottom) || 0;\n      const contentHeight = rectHeight - paddingTop - paddingBottom;\n      if (contentHeight <= 0) return 1;\n      const naturalHeight = numLines * lineHeight;\n      if (naturalHeight <= contentHeight * 1.05) return 1;\n      return contentHeight / naturalHeight;\n    }\n    function applyAutoScale(runs, elementFontSize, scaleFactor) {\n      if (scaleFactor >= 1) return elementFontSize;\n      for (const run of runs) {\n        if (!run.breakLine && run.fontSize) {\n          run.fontSize = run.fontSize * scaleFactor;\n        }\n      }\n      return elementFontSize * scaleFactor;\n    }\n    function extractTableData(table) {\n      const rows = [];\n      const colWidths = [];\n      for (const tr of Array.from(table.querySelectorAll("tr"))) {\n        const cells = [];\n        const isFirstRow = rows.length === 0;\n        const trStyle = getComputedStyle(tr);\n        const trBg = trStyle.backgroundColor;\n        const trHasBg = !!trBg && trBg !== "transparent" && trBg !== "rgba(0, 0, 0, 0)";\n        for (const td of Array.from(tr.querySelectorAll("th, td"))) {\n          const style = getComputedStyle(td);\n          const tdColSpan = td.colSpan || 1;\n          const tdRowSpan = td.rowSpan || 1;\n          if (isFirstRow) {\n            const perColWidth = td.offsetWidth / tdColSpan;\n            for (let i = 0; i < tdColSpan; i++) {\n              colWidths.push(perColWidth);\n            }\n          }\n          const cellBg = style.backgroundColor;\n          const cellHasBg = !!cellBg && cellBg !== "transparent" && cellBg !== "rgba(0, 0, 0, 0)";\n          const effectiveBg = cellHasBg ? cellBg : trHasBg ? trBg : cellBg;\n          const cellRuns = extractTextRuns(td);\n          const paragraphs = [{ runs: [] }];\n          for (const run of cellRuns) {\n            if (run.breakLine) {\n              paragraphs.push({ runs: [] });\n            } else {\n              paragraphs[paragraphs.length - 1].runs.push(run);\n            }\n          }\n          if (paragraphs.length > 1 && paragraphs[paragraphs.length - 1].runs.length === 0) {\n            paragraphs.pop();\n          }\n          cells.push({\n            text: td.textContent ?? "",\n            runs: cellRuns,\n            paragraphs,\n            isHeader: td.tagName.toLowerCase() === "th",\n            ...tdColSpan > 1 ? { colspan: tdColSpan } : {},\n            ...tdRowSpan > 1 ? { rowspan: tdRowSpan } : {},\n            style: {\n              color: style.color,\n              backgroundColor: effectiveBg,\n              fontSize: parseFloat(style.fontSize) || 16,\n              fontFamily: style.fontFamily,\n              fontWeight: parseInt(style.fontWeight, 10) || 400,\n              textAlign: style.textAlign || "left",\n              borderColor: style.borderColor,\n              paddingTop: parseFloat(style.paddingTop) || 0,\n              paddingRight: parseFloat(style.paddingRight) || 0,\n              paddingBottom: parseFloat(style.paddingBottom) || 0,\n              paddingLeft: parseFloat(style.paddingLeft) || 0\n            }\n          });\n        }\n        rows.push({ cells });\n      }\n      return { rows, colWidths };\n    }\n    function extractInlineBadgeShapes(container, slideRect, containerRect) {\n      const badges = [];\n      const badgeEls = [];\n      const bgOnlyElements = [];\n      const containerSSLeft = containerRect ? containerRect.left - slideRect.left : -Infinity;\n      const containerHasNonBadgeText = (() => {\n        for (const node of Array.from(container.childNodes)) {\n          if (node.nodeType === Node.TEXT_NODE) {\n            if ((node.textContent ?? "").trim() !== "") return true;\n            continue;\n          }\n          if (node.nodeType !== Node.ELEMENT_NODE) continue;\n          const cs = getComputedStyle(node);\n          if (cs.display === "none" || cs.visibility === "hidden") continue;\n          const isChildBadge = cs.display === "inline-block" || cs.display === "inline-flex" || cs.display === "inline-grid";\n          if (!isChildBadge) return true;\n        }\n        return false;\n      })();\n      for (const el of Array.from(container.querySelectorAll("*"))) {\n        const s = getComputedStyle(el);\n        const inlineTag = el.tagName.toLowerCase();\n        const isSemanticInlineHighlight = isSemanticInlineHighlightTag(inlineTag);\n        const isInlineBadgeDisplay = !isSemanticInlineHighlight && (s.display === "inline-block" || s.display === "inline-flex" || s.display === "inline-grid");\n        const inlineBorderRadius = parseFloat(s.borderRadius) || 0;\n        const isInlineWithRoundedBg = !isSemanticInlineHighlight && s.display === "inline" && inlineTag === "span" && inlineBorderRadius > 0;\n        if (!isInlineBadgeDisplay && !isInlineWithRoundedBg) continue;\n        const bg = s.backgroundColor;\n        if (!bg || bg === "transparent") continue;\n        const alphaMatch = bg.match(/,\\s*([\\d.]+)\\s*\\)$/);\n        if (alphaMatch && parseFloat(alphaMatch[1]) === 0) continue;\n        if (isInlineWithRoundedBg && alphaMatch && parseFloat(alphaMatch[1]) < 0.5) continue;\n        const iRect = el.getBoundingClientRect();\n        if (iRect.width === 0 || iRect.height === 0) continue;\n        if (isInlineBadgeDisplay && containerRect && containerHasNonBadgeText) {\n          const badgeSSLeft = iRect.left - slideRect.left;\n          if (badgeSSLeft > containerSSLeft + 8) {\n            badges.push({\n              type: "container",\n              children: [],\n              x: iRect.left - slideRect.left,\n              y: iRect.top - slideRect.top,\n              width: iRect.width,\n              height: iRect.height,\n              style: {\n                backgroundColor: bg,\n                ...inlineBorderRadius > 0 ? { borderRadius: inlineBorderRadius } : {}\n              }\n            });\n            bgOnlyElements.push(el);\n            continue;\n          }\n        }\n        const br = inlineBorderRadius;\n        const badgeRuns = extractTextRuns(el);\n        badgeRuns.forEach((r) => {\n          if (!r.breakLine) r.backgroundColor = void 0;\n        });\n        const hasBadgeText = badgeRuns.some(\n          (r) => !r.breakLine && r.text.trim() !== ""\n        );\n        badges.push({\n          type: "container",\n          children: [],\n          ...hasBadgeText ? { runs: badgeRuns } : {},\n          x: iRect.left - slideRect.left,\n          y: iRect.top - slideRect.top,\n          width: iRect.width,\n          height: iRect.height,\n          style: {\n            backgroundColor: bg,\n            ...br > 0 ? { borderRadius: br } : {}\n          }\n        });\n        badgeEls.push(el);\n      }\n      return { shapes: badges, elements: badgeEls, bgOnlyElements };\n    }\n    function extractNestedImages(el, slideRect) {\n      const images = [];\n      for (const img of Array.from(el.querySelectorAll("img"))) {\n        const imgEl = img;\n        const rect = imgEl.getBoundingClientRect();\n        if (rect.width === 0 || rect.height === 0) continue;\n        const s = getComputedStyle(imgEl);\n        if (s.display === "none" || s.visibility === "hidden") continue;\n        if (isEmojiImg(imgEl)) continue;\n        const cssFilter = s.filter && s.filter !== "none" ? s.filter : void 0;\n        images.push({\n          type: "image",\n          src: imgEl.src,\n          naturalWidth: imgEl.naturalWidth,\n          naturalHeight: imgEl.naturalHeight,\n          x: rect.left - slideRect.left,\n          y: rect.top - slideRect.top,\n          width: rect.width,\n          height: rect.height,\n          ...cssFilter ? { cssFilter, pageX: rect.left, pageY: rect.top } : {}\n        });\n      }\n      for (const svg of Array.from(el.querySelectorAll("svg"))) {\n        const rect = svg.getBoundingClientRect();\n        if (rect.width === 0 || rect.height === 0) continue;\n        try {\n          const svgStr = new XMLSerializer().serializeToString(svg);\n          const b64 = btoa(unescape(encodeURIComponent(svgStr)));\n          const dataUrl = `data:image/svg+xml;base64,${b64}`;\n          images.push({\n            type: "image",\n            src: dataUrl,\n            naturalWidth: rect.width,\n            naturalHeight: rect.height,\n            x: rect.left - slideRect.left,\n            y: rect.top - slideRect.top,\n            width: rect.width,\n            height: rect.height,\n            rasterize: true\n          });\n        } catch {\n        }\n      }\n      return images;\n    }\n    function walkElements(parent, slideRect) {\n      const elements = [];\n      for (const child of Array.from(parent.children)) {\n        const style = getComputedStyle(child);\n        if (style.display === "none" || style.visibility === "hidden") continue;\n        if (child.dataset?.marpitPresenterNotes !== void 0)\n          continue;\n        if (child.dataset?.marpitAdvancedBackgroundContainer !== void 0)\n          continue;\n        const rect = child.getBoundingClientRect();\n        if (rect.width === 0 || rect.height === 0) continue;\n        const tag = child.tagName.toLowerCase();\n        const parentIsFlexOrGrid = /^(flex|inline-flex|grid|inline-grid)/.test(\n          getComputedStyle(parent).display\n        );\n        if (!parentIsFlexOrGrid && tag !== "img" && tag !== "svg" && style.display === "inline")\n          continue;\n        const base = {\n          x: rect.left - slideRect.left,\n          y: rect.top - slideRect.top,\n          width: rect.width,\n          height: rect.height\n        };\n        if (/^h[1-6]$/.test(tag)) {\n          const borderBottomWidth = parseFloat(style.borderBottomWidth) || 0;\n          const borderBottomStyle = style.borderBottomStyle;\n          const borderLeftWidth = parseFloat(style.borderLeftWidth) || 0;\n          const { shapes: headingBadgeShapes, elements: headingBadgeEls, bgOnlyElements: headingBgOnlyEls } = extractInlineBadgeShapes(child, slideRect, rect);\n          const headingLeadingOffset = computeLeadingOffset(\n            headingBadgeShapes,\n            rect,\n            slideRect\n          );\n          if (headingBadgeShapes.length > 0) elements.push(...headingBadgeShapes);\n          const headingBadgeSet = headingBadgeEls.length > 0 ? new Set(headingBadgeEls) : false;\n          const headingBgOnlySet = headingBgOnlyEls.length > 0 ? new Set(headingBgOnlyEls) : false;\n          const headingPaddingTop = parseFloat(style.paddingTop) || 0;\n          const headingPaddingRight = parseFloat(style.paddingRight) || 0;\n          const headingPaddingBottom = parseFloat(style.paddingBottom) || 0;\n          const headingPaddingLeft = parseFloat(style.paddingLeft) || 0;\n          const headingRuns = extractTextRuns(child, headingBadgeSet, headingBgOnlySet);\n          if (headingBadgeShapes.length === 0 || headingRuns.some((r) => !r.breakLine && r.text.trim() !== "")) {\n            elements.push({\n              type: "heading",\n              level: parseInt(tag[1], 10),\n              runs: headingRuns,\n              ...base,\n              x: base.x + headingLeadingOffset,\n              width: Math.max(10, base.width - headingLeadingOffset),\n              style: {\n                ...extractTextStyle(style),\n                ...headingPaddingTop || headingPaddingRight || headingPaddingBottom || headingPaddingLeft ? { paddingTop: headingPaddingTop, paddingRight: headingPaddingRight, paddingBottom: headingPaddingBottom, paddingLeft: headingPaddingLeft } : {}\n              },\n              ...borderBottomWidth > 0 ? {\n                borderBottom: {\n                  width: borderBottomWidth,\n                  color: style.borderBottomColor,\n                  ...borderBottomStyle && borderBottomStyle !== "solid" && borderBottomStyle !== "none" ? { style: borderBottomStyle } : {}\n                }\n              } : {},\n              ...borderLeftWidth > 0 ? {\n                borderLeft: {\n                  width: borderLeftWidth,\n                  color: style.borderLeftColor\n                }\n              } : {}\n            });\n          }\n          elements.push(...extractNestedImages(child, slideRect));\n        } else if (tag === "p") {\n          if (child.querySelector("mjx-container")) {\n            const pRect = child.getBoundingClientRect();\n            if (pRect.width > 0 && pRect.height > 0) {\n              elements.push({\n                type: "image",\n                src: "",\n                // placeholder \u2014 rasterizeSlideTargets fills this via screenshot\n                naturalWidth: pRect.width,\n                naturalHeight: pRect.height,\n                x: pRect.left - slideRect.left,\n                y: pRect.top - slideRect.top,\n                width: pRect.width,\n                height: pRect.height,\n                rasterize: true\n              });\n            }\n            continue;\n          }\n          const { shapes: paraBadgeShapes, elements: paraBadgeEls, bgOnlyElements: paraBgOnlyEls } = extractInlineBadgeShapes(child, slideRect, rect);\n          const paraLeadingOffset = computeLeadingOffset(\n            paraBadgeShapes,\n            rect,\n            slideRect\n          );\n          if (paraBadgeShapes.length > 0) elements.push(...paraBadgeShapes);\n          let inlineImgXOffset = 0;\n          let inlineImgYOffset = 0;\n          {\n            let firstNonEmojiImg = null;\n            let seenBrAfterImg = false;\n            for (const node of Array.from(child.childNodes)) {\n              if (node.nodeType === Node.ELEMENT_NODE) {\n                const en = node;\n                const enTag = en.tagName.toLowerCase();\n                if (enTag === "img") {\n                  const ie = en;\n                  if (!isEmojiImg(ie)) {\n                    if (!firstNonEmojiImg) firstNonEmojiImg = ie;\n                  }\n                  continue;\n                }\n                if (enTag === "br" && firstNonEmojiImg && !seenBrAfterImg) {\n                  seenBrAfterImg = true;\n                  continue;\n                }\n                break;\n              } else if (node.nodeType === Node.TEXT_NODE) {\n                if ((node.textContent ?? "").trim() !== "") break;\n              }\n            }\n            if (firstNonEmojiImg) {\n              const imgR = firstNonEmojiImg.getBoundingClientRect();\n              if (seenBrAfterImg) {\n                inlineImgYOffset = imgR.bottom - rect.top;\n              } else {\n                inlineImgXOffset = imgR.right - rect.left;\n                const parsedLH = parseFloat(style.lineHeight);\n                const lineHeight = !isNaN(parsedLH) && parsedLH > 0 ? parsedLH : (parseFloat(style.fontSize) || 16) * 1.5;\n                inlineImgYOffset = Math.max(0, imgR.bottom - rect.top - lineHeight);\n              }\n            }\n          }\n          const paraBadgeSet = paraBadgeEls.length > 0 ? new Set(paraBadgeEls) : false;\n          const paraBgOnlySet = paraBgOnlyEls.length > 0 ? new Set(paraBgOnlyEls) : false;\n          const runs = extractTextRuns(child, paraBadgeSet, paraBgOnlySet);\n          if (runs.some((r) => !r.breakLine && r.text.trim() !== "")) {\n            elements.push({\n              type: "paragraph",\n              runs,\n              ...base,\n              x: base.x + paraLeadingOffset + inlineImgXOffset,\n              y: base.y + inlineImgYOffset,\n              width: Math.max(10, base.width - paraLeadingOffset - inlineImgXOffset),\n              height: Math.max(10, base.height - inlineImgYOffset),\n              style: extractTextStyle(style)\n            });\n          }\n          elements.push(...extractNestedImages(child, slideRect));\n        } else if (tag === "ul" || tag === "ol") {\n          const liChildren = Array.from(child.children).filter(\n            (c) => c.tagName.toLowerCase() === "li"\n          );\n          const hasEmbeddedImage = liChildren.some(\n            (li) => Array.from(li.querySelectorAll("img")).some(\n              (img) => !isEmojiImg(img)\n            )\n          );\n          const hasEmbeddedCode = liChildren.some(\n            (li) => Array.from(li.children).some((c) => {\n              const t = c.tagName.toLowerCase();\n              return t === "pre" || t === "marp-pre";\n            })\n          );\n          const olStart = tag === "ol" ? child.start || 1 : 1;\n          const olHasExplicitStart = tag === "ol" && child.hasAttribute("start");\n          if (!hasEmbeddedImage && !hasEmbeddedCode) {\n            const liBadgeSets = /* @__PURE__ */ new Map();\n            const liBgOnlySets = /* @__PURE__ */ new Map();\n            const liLeadingOffsetMap = /* @__PURE__ */ new Map();\n            for (const li of liChildren) {\n              const liRect = li.getBoundingClientRect();\n              const { shapes: liBadgeShapes, elements: liBadgeEls, bgOnlyElements: liBgOnlyEls } = extractInlineBadgeShapes(li, slideRect, liRect);\n              const liLeadingOffset = computeLeadingOffset(\n                liBadgeShapes,\n                liRect,\n                slideRect\n              );\n              if (liBadgeShapes.length > 0) {\n                elements.push(...liBadgeShapes);\n              }\n              if (liBadgeEls.length > 0) {\n                liBadgeSets.set(li, new Set(liBadgeEls));\n              }\n              if (liBgOnlyEls.length > 0) {\n                liBgOnlySets.set(li, new Set(liBgOnlyEls));\n              }\n              if (liLeadingOffset > 0) {\n                liLeadingOffsetMap.set(li, liLeadingOffset);\n              }\n            }\n            elements.push({\n              type: "list",\n              ordered: tag === "ol",\n              ...olHasExplicitStart ? { startNumber: olStart } : {},\n              listStyleType: style.listStyleType || void 0,\n              items: extractListItems(\n                child,\n                0,\n                liBadgeSets.size > 0 ? liBadgeSets : void 0,\n                liBgOnlySets.size > 0 ? liBgOnlySets : void 0,\n                liLeadingOffsetMap.size > 0 ? liLeadingOffsetMap : void 0\n              ),\n              ...base,\n              style: extractTextStyle(style)\n            });\n            elements.push(...extractNestedImages(child, slideRect));\n            for (const li of liChildren) {\n              for (const preChild of Array.from(li.children)) {\n                const preChildTag = preChild.tagName.toLowerCase();\n                if (preChildTag !== "pre" && preChildTag !== "marp-pre") continue;\n                if (preChild.querySelector("svg")) continue;\n                const preRect = preChild.getBoundingClientRect();\n                if (preRect.width <= 0 || preRect.height <= 0) continue;\n                const preStyle = getComputedStyle(preChild);\n                const codeEl = preChild.querySelector("code");\n                const codeTarget = codeEl ?? preChild;\n                const preBg = preStyle.backgroundColor;\n                const codeBg = preBg && preBg !== "transparent" && preBg !== "rgba(0, 0, 0, 0)" && preBg !== "rgba(0,0,0,0)" ? preBg : codeEl ? getComputedStyle(codeEl).backgroundColor : preBg;\n                const preCodeRuns = extractCodeRuns(codeTarget);\n                const preScaleFactor = computeAutoScaleFactor(preCodeRuns, preStyle, preRect.height);\n                const preBaseStyle = extractTextStyle(preStyle);\n                const preAdjustedFs = applyAutoScale(preCodeRuns, preBaseStyle.fontSize, preScaleFactor);\n                elements.push({\n                  type: "code",\n                  text: codeTarget.textContent ?? "",\n                  language: codeEl?.className?.replace("language-", "") ?? "",\n                  runs: preCodeRuns,\n                  x: preRect.left - slideRect.left,\n                  y: preRect.top - slideRect.top,\n                  width: preRect.width,\n                  height: preRect.height,\n                  style: {\n                    ...preBaseStyle,\n                    fontSize: preAdjustedFs,\n                    backgroundColor: codeBg\n                  }\n                });\n              }\n            }\n          } else {\n            let olRunningNumber = olStart;\n            let pendingItems = [];\n            let pendingTop = -1;\n            let pendingBottom = -1;\n            const flushPending = () => {\n              if (pendingItems.length === 0) return;\n              const chunkStart = olRunningNumber;\n              elements.push({\n                type: "list",\n                ordered: tag === "ol",\n                ...olHasExplicitStart || chunkStart > 1 ? { startNumber: chunkStart } : {},\n                listStyleType: style.listStyleType || void 0,\n                items: pendingItems,\n                x: base.x,\n                y: pendingTop,\n                width: base.width,\n                height: Math.max(10, pendingBottom - pendingTop),\n                style: extractTextStyle(style)\n              });\n              olRunningNumber += pendingItems.length;\n              pendingItems = [];\n              pendingTop = -1;\n              pendingBottom = -1;\n            };\n            for (const li of liChildren) {\n              const liImages = Array.from(li.querySelectorAll("img")).filter(\n                (img) => !isEmojiImg(img)\n              );\n              const liRect = li.getBoundingClientRect();\n              const liY = liRect.top - slideRect.top;\n              const liBottom = liRect.bottom - slideRect.top;\n              const { shapes: liSplitBadgeShapes, elements: liSplitBadgeEls, bgOnlyElements: liSplitBgOnlyEls } = extractInlineBadgeShapes(li, slideRect, liRect);\n              const liLeadingOffset = computeLeadingOffset(\n                liSplitBadgeShapes,\n                liRect,\n                slideRect\n              );\n              const liSplitSkipBadges = liSplitBadgeEls.length > 0 ? new Set(liSplitBadgeEls) : false;\n              const liSplitStripBadges = liSplitBgOnlyEls.length > 0 ? new Set(liSplitBgOnlyEls) : false;\n              if (liSplitBadgeShapes.length > 0) elements.push(...liSplitBadgeShapes);\n              if (liImages.length === 0) {\n                const liCodeChildren = Array.from(li.children).filter((c) => {\n                  const t = c.tagName.toLowerCase();\n                  return (t === "pre" || t === "marp-pre") && !c.querySelector("svg");\n                });\n                const liItems = extractListItemEl(\n                  li,\n                  0,\n                  liSplitSkipBadges,\n                  liSplitStripBadges,\n                  liLeadingOffset\n                );\n                if (liCodeChildren.length === 0) {\n                  if (pendingTop < 0) pendingTop = liY;\n                  pendingBottom = liBottom;\n                  pendingItems.push(...liItems);\n                } else {\n                  if (pendingTop < 0) pendingTop = liY;\n                  const firstCodeRect = liCodeChildren[0].getBoundingClientRect();\n                  pendingBottom = firstCodeRect.top - slideRect.top;\n                  pendingItems.push(...liItems);\n                  flushPending();\n                  for (const preChild of liCodeChildren) {\n                    const preRect = preChild.getBoundingClientRect();\n                    if (preRect.width <= 0 || preRect.height <= 0) continue;\n                    const preStyle = getComputedStyle(preChild);\n                    const codeEl = preChild.querySelector("code");\n                    const codeTarget = codeEl ?? preChild;\n                    const preBg = preStyle.backgroundColor;\n                    const codeBg = preBg && preBg !== "transparent" && preBg !== "rgba(0, 0, 0, 0)" && preBg !== "rgba(0,0,0,0)" ? preBg : codeEl ? getComputedStyle(codeEl).backgroundColor : preBg;\n                    const preCodeRuns = extractCodeRuns(codeTarget);\n                    const preScaleFactor = computeAutoScaleFactor(preCodeRuns, preStyle, preRect.height);\n                    const preBaseStyle = extractTextStyle(preStyle);\n                    const preAdjustedFs = applyAutoScale(preCodeRuns, preBaseStyle.fontSize, preScaleFactor);\n                    elements.push({\n                      type: "code",\n                      text: codeTarget.textContent ?? "",\n                      language: codeEl?.className?.replace("language-", "") ?? "",\n                      runs: preCodeRuns,\n                      x: preRect.left - slideRect.left,\n                      y: preRect.top - slideRect.top,\n                      width: preRect.width,\n                      height: preRect.height,\n                      style: {\n                        ...preBaseStyle,\n                        fontSize: preAdjustedFs,\n                        backgroundColor: codeBg\n                      }\n                    });\n                  }\n                }\n              } else {\n                const liItems = extractListItemEl(\n                  li,\n                  0,\n                  liSplitSkipBadges,\n                  liSplitStripBadges,\n                  liLeadingOffset\n                );\n                if (liItems.length > 0) {\n                  if (pendingTop < 0) pendingTop = liY;\n                  pendingBottom = liBottom;\n                  pendingItems.push(...liItems);\n                }\n                flushPending();\n                for (const img of liImages) {\n                  const imgRect = img.getBoundingClientRect();\n                  const imgFilter = getComputedStyle(img).filter && getComputedStyle(img).filter !== "none" ? getComputedStyle(img).filter : void 0;\n                  elements.push({\n                    type: "image",\n                    src: img.src,\n                    naturalWidth: img.naturalWidth,\n                    naturalHeight: img.naturalHeight,\n                    x: imgRect.left - slideRect.left,\n                    y: imgRect.top - slideRect.top,\n                    width: imgRect.width,\n                    height: imgRect.height,\n                    ...imgFilter ? { cssFilter: imgFilter, pageX: imgRect.left, pageY: imgRect.top } : {}\n                  });\n                }\n              }\n            }\n            flushPending();\n          }\n        } else if (tag === "table") {\n          const { rows: tableRows, colWidths } = extractTableData(child);\n          elements.push({\n            type: "table",\n            rows: tableRows,\n            ...colWidths.length > 0 ? { colWidths } : {},\n            ...base,\n            style: extractTextStyle(style)\n          });\n          elements.push(...extractNestedImages(child, slideRect));\n        } else if (tag === "pre" || tag === "marp-pre") {\n          const innerSvg = child.querySelector("svg");\n          if (innerSvg) {\n            try {\n              const svgStr = new XMLSerializer().serializeToString(innerSvg);\n              const b64 = btoa(unescape(encodeURIComponent(svgStr)));\n              const dataUrl = `data:image/svg+xml;base64,${b64}`;\n              elements.push({\n                type: "image",\n                src: dataUrl,\n                naturalWidth: base.width,\n                naturalHeight: base.height,\n                ...base,\n                // Request rasterization: Mermaid SVGs may use <foreignObject>\n                // for text labels which PowerPoint cannot render from SVG data.\n                // pageX/pageY are intentionally omitted: rasterizeSlideTargets\n                // computes the absolute clip from the slide-relative x/y after\n                // navigating to the correct slide (avoids stale bespoke-transform\n                // coordinates).\n                rasterize: true\n              });\n            } catch {\n              const code = child.querySelector("code");\n              const codeTarget = code ?? child;\n              const preBgCatch = style.backgroundColor;\n              const codeBgCatch = preBgCatch && preBgCatch !== "transparent" && preBgCatch !== "rgba(0, 0, 0, 0)" && preBgCatch !== "rgba(0,0,0,0)" ? preBgCatch : code ? getComputedStyle(code).backgroundColor : preBgCatch;\n              const codeRunsCatch = extractCodeRuns(codeTarget);\n              const scaleFactorCatch = computeAutoScaleFactor(codeRunsCatch, style, rect.height);\n              const baseStyleCatch = extractTextStyle(style);\n              const adjustedFsCatch = applyAutoScale(codeRunsCatch, baseStyleCatch.fontSize, scaleFactorCatch);\n              elements.push({\n                type: "code",\n                text: codeTarget.textContent ?? "",\n                language: code?.className?.replace("language-", "") ?? "",\n                runs: codeRunsCatch,\n                ...base,\n                style: {\n                  ...baseStyleCatch,\n                  fontSize: adjustedFsCatch,\n                  backgroundColor: codeBgCatch\n                }\n              });\n            }\n          } else {\n            const code = child.querySelector("code");\n            const codeTarget = code ?? child;\n            const preBgStd = style.backgroundColor;\n            const codeBgStd = preBgStd && preBgStd !== "transparent" && preBgStd !== "rgba(0, 0, 0, 0)" && preBgStd !== "rgba(0,0,0,0)" ? preBgStd : code ? getComputedStyle(code).backgroundColor : preBgStd;\n            const codeRuns = extractCodeRuns(codeTarget);\n            const scaleFactor = computeAutoScaleFactor(codeRuns, style, rect.height);\n            const baseStyle = extractTextStyle(style);\n            const adjustedFontSize = applyAutoScale(codeRuns, baseStyle.fontSize, scaleFactor);\n            elements.push({\n              type: "code",\n              text: codeTarget.textContent ?? "",\n              language: code?.className?.replace("language-", "") ?? "",\n              runs: codeRuns,\n              ...base,\n              style: {\n                ...baseStyle,\n                fontSize: adjustedFontSize,\n                backgroundColor: codeBgStd\n              }\n            });\n          }\n        } else if (tag === "img") {\n          const img = child;\n          if (img.classList?.contains("emoji") || img.src?.includes("twemoji") || img.src?.includes("/emoji/"))\n            continue;\n          const imgFilter = style.filter && style.filter !== "none" ? style.filter : void 0;\n          elements.push({\n            type: "image",\n            src: img.src,\n            naturalWidth: img.naturalWidth,\n            naturalHeight: img.naturalHeight,\n            ...base,\n            // Store page-absolute coords when cssFilter is set so the export\n            // tool can screenshot the rendered (filtered) region via Puppeteer.\n            ...imgFilter ? { cssFilter: imgFilter, pageX: rect.left, pageY: rect.top } : {}\n          });\n        } else if (tag === "blockquote") {\n          const borderWidth = parseFloat(style.borderLeftWidth) || 0;\n          const borderColor = style.borderLeftColor;\n          const paddingTop = parseFloat(style.paddingTop) || 0;\n          const paddingRight = parseFloat(style.paddingRight) || 0;\n          const paddingBottom = parseFloat(style.paddingBottom) || 0;\n          const paddingLeft = parseFloat(style.paddingLeft) || 0;\n          const { shapes: bqBadgeShapes, elements: bqBadgeEls, bgOnlyElements: bqBgOnlyEls } = extractInlineBadgeShapes(child, slideRect, rect);\n          const bqLeadingOffset = computeLeadingOffset(\n            bqBadgeShapes,\n            rect,\n            slideRect\n          );\n          if (bqBadgeShapes.length > 0) elements.push(...bqBadgeShapes);\n          const bqBadgeSet = bqBadgeEls.length > 0 ? new Set(bqBadgeEls) : false;\n          const bqBgOnlySet = bqBgOnlyEls.length > 0 ? new Set(bqBgOnlyEls) : false;\n          const directListEls = Array.from(child.children).filter((c) => {\n            const t = c.tagName.toLowerCase();\n            return t === "ul" || t === "ol";\n          });\n          const directListSet = directListEls.length > 0 ? new Set(directListEls) : false;\n          elements.push({\n            type: "blockquote",\n            runs: extractTextRuns(child, bqBadgeSet, bqBgOnlySet, directListSet),\n            ...base,\n            x: base.x + bqLeadingOffset,\n            width: Math.max(10, base.width - bqLeadingOffset),\n            style: {\n              ...extractTextStyle(style),\n              ...paddingTop || paddingRight || paddingBottom || paddingLeft ? { paddingTop, paddingRight, paddingBottom, paddingLeft } : {}\n            },\n            ...borderWidth > 0 ? { borderLeft: { width: borderWidth, color: borderColor } } : {}\n          });\n          for (const listEl of directListEls) {\n            const listRect = listEl.getBoundingClientRect();\n            if (listRect.width <= 0 || listRect.height <= 0) continue;\n            const listStyle = getComputedStyle(listEl);\n            const listTag = listEl.tagName.toLowerCase();\n            const listOrdered = listTag === "ol";\n            const olStart = listOrdered ? listEl.start || 1 : 1;\n            const olHasExplicitStart = listOrdered && listEl.hasAttribute("start");\n            elements.push({\n              type: "list",\n              ordered: listOrdered,\n              ...olHasExplicitStart ? { startNumber: olStart } : {},\n              listStyleType: listStyle.listStyleType || void 0,\n              items: extractListItems(listEl, 0),\n              x: listRect.left - slideRect.left,\n              y: listRect.top - slideRect.top,\n              width: listRect.width,\n              height: listRect.height,\n              style: extractTextStyle(listStyle)\n            });\n          }\n          elements.push(...extractNestedImages(child, slideRect));\n        } else if (tag === "svg") {\n          try {\n            const svgStr = new XMLSerializer().serializeToString(child);\n            const b64 = btoa(unescape(encodeURIComponent(svgStr)));\n            const dataUrl = `data:image/svg+xml;base64,${b64}`;\n            const hasForeignObject = child.querySelector("foreignObject") !== null;\n            elements.push({\n              type: "image",\n              src: dataUrl,\n              naturalWidth: base.width,\n              naturalHeight: base.height,\n              ...base,\n              ...hasForeignObject ? { rasterize: true } : {}\n            });\n          } catch {\n          }\n        } else if (tag === "header" || tag === "footer") {\n          const { shapes: hfBadgeShapes, elements: hfBadgeEls, bgOnlyElements: hfBgOnlyEls } = extractInlineBadgeShapes(child, slideRect, rect);\n          const hfLeadingOffset = computeLeadingOffset(\n            hfBadgeShapes,\n            rect,\n            slideRect\n          );\n          if (hfBadgeShapes.length > 0) elements.push(...hfBadgeShapes);\n          const hfBadgeSet = hfBadgeEls.length > 0 ? new Set(hfBadgeEls) : false;\n          const hfBgOnlySet = hfBgOnlyEls.length > 0 ? new Set(hfBgOnlyEls) : false;\n          const hfWidth = Math.max(\n            base.width - hfLeadingOffset,\n            slideRect.width - base.x - hfLeadingOffset\n          );\n          elements.push({\n            type: tag,\n            runs: extractTextRuns(child, hfBadgeSet, hfBgOnlySet),\n            ...base,\n            x: base.x + hfLeadingOffset,\n            width: hfWidth,\n            style: extractTextStyle(style)\n          });\n          elements.push(...extractNestedImages(child, slideRect));\n        } else {\n          const borderTopWidth = parseFloat(style.borderTopWidth) || 0;\n          const borderTopStyle = style.borderTopStyle;\n          const hasBorder = borderTopWidth > 0 && borderTopStyle !== "none";\n          const borderRadius = parseFloat(style.borderRadius) || 0;\n          const borderLeftWidth = parseFloat(style.borderLeftWidth) || 0;\n          const borderLeftStyle = style.borderLeftStyle;\n          const hasBorderLeft = borderLeftWidth > 0 && borderLeftStyle !== "none" && !hasBorder;\n          const borderBottomWidth = parseFloat(style.borderBottomWidth) || 0;\n          const borderBottomStyle = style.borderBottomStyle;\n          const hasBorderBottom = borderBottomWidth > 0 && borderBottomStyle !== "none" && !hasBorder;\n          const boxShadow = style.boxShadow;\n          const hasBoxShadow = !!boxShadow && boxShadow !== "none";\n          const hasBackground = !!style.backgroundColor && style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)" && !style.backgroundColor.match(\n            /rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0(?:\\.0+)?\\s*\\)/\n          );\n          const blockChildren = walkElements(child, slideRect);\n          const containerStyle = {\n            backgroundColor: style.backgroundColor,\n            ...hasBorder ? { borderWidth: borderTopWidth, borderColor: style.borderTopColor, borderStyle: borderTopStyle } : {},\n            ...borderRadius > 0 ? { borderRadius } : {},\n            ...hasBorderLeft ? {\n              borderLeft: {\n                width: borderLeftWidth,\n                color: style.borderLeftColor\n              }\n            } : {},\n            ...hasBorderBottom ? {\n              borderBottom: {\n                width: borderBottomWidth,\n                color: style.borderBottomColor,\n                style: borderBottomStyle\n              }\n            } : {},\n            ...hasBoxShadow ? { boxShadow: true } : {}\n          };\n          const containerIsFlexOrGrid = /^(flex|inline-flex|grid|inline-grid)/.test(\n            style.display\n          );\n          if (blockChildren.length > 0) {\n            elements.push({\n              type: "container",\n              children: blockChildren,\n              ...base,\n              style: containerStyle\n            });\n            const blockChildrenAllInlineLevel = (() => {\n              if (containerIsFlexOrGrid) return false;\n              if (blockChildren.length === 0) return false;\n              for (const node of Array.from(child.children)) {\n                const ns = getComputedStyle(node);\n                if (ns.display === "none" || ns.visibility === "hidden") continue;\n                const nr = node.getBoundingClientRect();\n                if (nr.width === 0 || nr.height === 0) continue;\n                if (ns.display === "inline") continue;\n                if (/^inline-/.test(ns.display)) continue;\n                return false;\n              }\n              return true;\n            })();\n            const shouldRecoverTextNodes = containerIsFlexOrGrid || blockChildrenAllInlineLevel;\n            const hasVisibleDirectText = (() => {\n              if (shouldRecoverTextNodes) return false;\n              for (const node of Array.from(child.childNodes)) {\n                if (node.nodeType !== Node.TEXT_NODE) continue;\n                const text = (node.textContent ?? "").trim();\n                if (text === "") continue;\n                try {\n                  const range = document.createRange();\n                  range.selectNodeContents(node);\n                  const rr = range.getBoundingClientRect();\n                  if (rr.width > 0 && rr.height > 0) return true;\n                } catch {\n                }\n              }\n              return false;\n            })();\n            const shallowRuns = [];\n            for (const node of Array.from(child.childNodes)) {\n              if (node.nodeType === Node.TEXT_NODE) {\n                if (!shouldRecoverTextNodes && !hasVisibleDirectText) continue;\n                const text = (node.textContent ?? "").trim();\n                if (text !== "") {\n                  const childStyle = getComputedStyle(child);\n                  shallowRuns.push({\n                    text,\n                    color: childStyle.color,\n                    fontSize: parseFloat(childStyle.fontSize) || 16,\n                    fontFamily: childStyle.fontFamily,\n                    bold: parseInt(childStyle.fontWeight, 10) >= 600,\n                    italic: childStyle.fontStyle === "italic",\n                    underline: childStyle.textDecorationLine?.includes("underline"),\n                    strikethrough: childStyle.textDecorationLine?.includes("line-through")\n                  });\n                }\n              } else if (node.nodeType === Node.ELEMENT_NODE) {\n                if (containerIsFlexOrGrid) continue;\n                const nodeEl = node;\n                const nodeTag = nodeEl.tagName.toLowerCase();\n                if (nodeTag === "svg") continue;\n                const nodeStyle = getComputedStyle(nodeEl);\n                if (nodeStyle.display === "inline") {\n                  const inlineRuns = extractTextRuns(nodeEl);\n                  shallowRuns.push(...inlineRuns);\n                }\n              }\n            }\n            while (shallowRuns.length > 0 && shallowRuns[shallowRuns.length - 1].breakLine)\n              shallowRuns.pop();\n            while (shallowRuns.length > 0 && shallowRuns[0].breakLine)\n              shallowRuns.shift();\n            if (shallowRuns.some((r) => !r.breakLine && r.text.trim() !== "")) {\n              const shallowLeadingOffset = containerIsFlexOrGrid ? computeShallowFlexOffset(child, rect, slideRect, style) : 0;\n              elements.push({\n                type: "paragraph",\n                runs: shallowRuns,\n                ...base,\n                x: base.x + shallowLeadingOffset,\n                width: Math.max(10, base.width - shallowLeadingOffset),\n                style: extractTextStyle(style)\n              });\n            }\n          } else {\n            if (hasBackground || hasBorder || hasBorderLeft || hasBorderBottom || hasBoxShadow) {\n              elements.push({\n                type: "container",\n                children: [],\n                ...base,\n                style: containerStyle\n              });\n            }\n            const runs = extractTextRuns(child);\n            if (hasBackground) {\n              const elBg = style.backgroundColor;\n              for (const r of runs) {\n                if (!r.breakLine && r.backgroundColor === elBg) {\n                  r.backgroundColor = void 0;\n                }\n              }\n            }\n            if (runs.some((r) => !r.breakLine && r.text.trim() !== "")) {\n              const valign = style.alignItems === "center" || style.justifyContent === "center" || style.verticalAlign === "middle" ? "middle" : "top";\n              const paddingTop = parseFloat(style.paddingTop) || 0;\n              const paddingRight = parseFloat(style.paddingRight) || 0;\n              const paddingBottom = parseFloat(style.paddingBottom) || 0;\n              const paddingLeft = parseFloat(style.paddingLeft) || 0;\n              const parentRight = parentIsFlexOrGrid ? parent.getBoundingClientRect().right - slideRect.left : 0;\n              const emojiWidthOverride = (() => {\n                if (!parentIsFlexOrGrid) return void 0;\n                const hasEmoji = runs.some(\n                  (r) => !r.breakLine && /\\p{Extended_Pictographic}/u.test(r.text)\n                );\n                if (!hasEmoji) return void 0;\n                let sib = child.nextElementSibling;\n                while (sib !== null) {\n                  const sibStyle = getComputedStyle(sib);\n                  if (sibStyle.display !== "none" && sibStyle.visibility !== "hidden") {\n                    const sibRect = sib.getBoundingClientRect();\n                    if (sibRect.width > 0 && sibRect.height > 0) return void 0;\n                  }\n                  sib = sib.nextElementSibling;\n                }\n                const extended = Math.max(base.width, parentRight - base.x);\n                return extended > base.width ? extended : void 0;\n              })();\n              const nowrapWidthOverride = (() => {\n                if (emojiWidthOverride !== void 0) return void 0;\n                if (!parentIsFlexOrGrid) return void 0;\n                if (style.whiteSpace !== "nowrap") return void 0;\n                const wantedWidth = base.width * 1.15;\n                const slideWidth = slideRect.width;\n                const maxWidth = Math.max(base.width, slideWidth - base.x);\n                const finalWidth = Math.min(wantedWidth, maxWidth);\n                return finalWidth > base.width ? finalWidth : void 0;\n              })();\n              const nowrapXShift = 0;\n              elements.push({\n                type: "paragraph",\n                runs,\n                ...base,\n                ...emojiWidthOverride !== void 0 ? { width: emojiWidthOverride } : nowrapWidthOverride !== void 0 ? { width: nowrapWidthOverride } : (\n                  // Inline-only containers (e.g. display:inline-block badges)\n                  // have tight-fitting widths from browser font metrics.\n                  // PowerPoint fonts may render slightly wider, causing text to\n                  // wrap.  Add a small slack (8 px) when the container has a\n                  // visible background (badge/chip pattern) to absorb the\n                  // font-metric variance.\n                  hasBackground ? { width: base.width + 8 } : parentIsFlexOrGrid ? {\n                    // ADR-23: Non-background text in flex/grid child containers\n                    // (e.g. step-body divs, label divs) can wrap in PPTX when\n                    // DirectWrite font metrics are slightly wider than Chrome\'s\n                    // Skia. The wrapping causes the next absolutely-positioned\n                    // item to overlap. Add 16px slack capped at parent right edge.\n                    width: Math.min(\n                      base.width + 16,\n                      Math.max(base.width, parentRight - base.x)\n                    )\n                  } : {}\n                ),\n                style: {\n                  ...extractTextStyle(style),\n                  ...paddingTop || paddingRight || paddingBottom || paddingLeft ? { paddingTop, paddingRight, paddingBottom, paddingLeft } : {}\n                },\n                valign\n              });\n            }\n            elements.push(...extractNestedImages(child, slideRect));\n          }\n        }\n      }\n      return elements;\n    }\n    const globalPseudoSignatures = /* @__PURE__ */ new Set();\n    function extractPseudoElements(section, slideRect) {\n      const shapes = [];\n      for (const pseudo of ["::before", "::after"]) {\n        const ps = getComputedStyle(section, pseudo);\n        const rawContent = ps.content;\n        if (!rawContent || rawContent === "none" || rawContent === "normal")\n          continue;\n        const stripped = rawContent.replace(/^["\']|["\']$/g, "").trim();\n        if (stripped === "") {\n          const sectionClass = section.className?.trim() ?? "";\n          if (!sectionClass) continue;\n          const pgBg = ps.backgroundColor;\n          if (!pgBg || pgBg === "transparent" || pgBg === "rgba(0, 0, 0, 0)" || globalPseudoSignatures.has(`${pseudo}:${pgBg}`))\n            continue;\n        }\n        const bg = ps.backgroundColor;\n        if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;\n        const w = parseFloat(ps.width) || 0;\n        const h = parseFloat(ps.height) || 0;\n        if (w === 0 && h === 0) continue;\n        const position = ps.position;\n        let x = 0;\n        let y = 0;\n        if (position === "absolute" || position === "fixed") {\n          const top = parseFloat(ps.top);\n          const left = parseFloat(ps.left);\n          const bottom = parseFloat(ps.bottom);\n          if (!isNaN(top)) y = top;\n          else if (!isNaN(bottom)) y = slideRect.height - bottom - h;\n          if (!isNaN(left)) x = left;\n        }\n        const effectiveW = w || slideRect.width;\n        const effectiveH = h || 0;\n        if (effectiveH <= 0) continue;\n        shapes.push({\n          type: "container",\n          children: [],\n          x,\n          y,\n          width: effectiveW,\n          height: effectiveH,\n          style: {\n            backgroundColor: bg\n          }\n        });\n      }\n      return shapes;\n    }\n    const allSections = Array.from(root.querySelectorAll("section")).filter(\n      (section) => {\n        if (section.parentElement?.closest("section")) return false;\n        if (section.parentElement?.tagName.toLowerCase() === "foreignobject") {\n          return true;\n        }\n        return section.hasAttribute("data-marpit-pagination");\n      }\n    );\n    const allSvgs = Array.from(\n      document.querySelectorAll("svg[data-marpit-svg]")\n    );\n    const slideGroups = /* @__PURE__ */ new Map();\n    for (const [index, section] of allSections.entries()) {\n      const fo = section.parentElement;\n      const svg = fo?.tagName.toLowerCase() === "foreignobject" ? fo.parentElement : null;\n      const key = svg?.hasAttribute("data-marpit-svg") ? String(allSvgs.indexOf(svg)) : section.getAttribute("data-marpit-pagination") ?? section.getAttribute("id") ?? String(index);\n      const layer = section.getAttribute("data-marpit-advanced-background");\n      if (!slideGroups.has(key)) slideGroups.set(key, {});\n      const entry = slideGroups.get(key);\n      if (layer === "content") {\n        entry.content = section;\n      } else if (layer === "background") {\n        entry.background = section;\n      } else if (layer === "pseudo") {\n        entry.pseudo = section;\n      } else {\n        entry.content = section;\n      }\n    }\n    for (const { content } of slideGroups.values()) {\n      const sec = content;\n      if (!sec) continue;\n      const secClass = sec.className?.trim() ?? "";\n      if (secClass) continue;\n      for (const pseudo of ["::before", "::after"]) {\n        const ps = getComputedStyle(sec, pseudo);\n        const rawC = ps.content;\n        if (!rawC || rawC === "none" || rawC === "normal") continue;\n        if (rawC.replace(/^["\']|["\']$/g, "").trim() !== "") continue;\n        const bg = ps.backgroundColor;\n        if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;\n        globalPseudoSignatures.add(`${pseudo}:${bg}`);\n      }\n    }\n    return Array.from(slideGroups.values()).map(\n      ({ content, background, pseudo }, slideIdx) => {\n        const section = content ?? background;\n        const sectionStyle = getComputedStyle(section);\n        let slideRect;\n        if (background && content) {\n          const fo = section.parentElement;\n          const svg = fo?.tagName.toLowerCase() === "foreignobject" ? fo.parentElement : null;\n          slideRect = svg?.hasAttribute("data-marpit-svg") ? svg.getBoundingClientRect() : section.getBoundingClientRect();\n        } else {\n          slideRect = section.getBoundingClientRect();\n        }\n        const sectionRect = slideRect;\n        const backgroundImages = [];\n        if (background) {\n          const figures = background.querySelectorAll("figure");\n          for (const fig of Array.from(figures)) {\n            const figStyle = getComputedStyle(fig);\n            if (!figStyle.backgroundImage || figStyle.backgroundImage === "none")\n              continue;\n            const urlMatch = figStyle.backgroundImage.match(\n              /url\\(["\']?([^"\')]+)["\']?\\)/\n            );\n            if (!urlMatch) continue;\n            const figRect = fig.getBoundingClientRect();\n            const cssFilter = figStyle.filter && figStyle.filter !== "none" ? figStyle.filter : void 0;\n            const bgSize = figStyle.backgroundSize;\n            const isContain = bgSize === "contain";\n            backgroundImages.push({\n              url: urlMatch[1],\n              x: figRect.left - sectionRect.left,\n              y: figRect.top - sectionRect.top,\n              width: figRect.width || sectionRect.width,\n              height: figRect.height || sectionRect.height,\n              ...cssFilter ? { cssFilter } : {},\n              ...isContain ? { backgroundSizeContain: true } : {},\n              pageX: figRect.left,\n              pageY: figRect.top\n            });\n          }\n        }\n        if (backgroundImages.length === 0) {\n          const bgImg = sectionStyle.backgroundImage;\n          if (bgImg && bgImg !== "none") {\n            const urlMatch = bgImg.match(/url\\(["\']?([^"\')]+)["\']?\\)/);\n            if (urlMatch) {\n              backgroundImages.push({\n                url: urlMatch[1],\n                x: 0,\n                y: 0,\n                width: sectionRect.width,\n                height: sectionRect.height,\n                pageX: sectionRect.left,\n                pageY: sectionRect.top,\n                fromCssFallback: true\n              });\n            } else if (/gradient\\s*\\(/.test(bgImg)) {\n              backgroundImages.push({\n                url: "",\n                // placeholder \u2014 will be replaced by rasterized data URL\n                x: 0,\n                y: 0,\n                width: sectionRect.width,\n                height: sectionRect.height,\n                pageX: sectionRect.left,\n                pageY: sectionRect.top,\n                fromCssFallback: true\n              });\n            }\n          }\n        }\n        return {\n          width: sectionRect.width,\n          height: sectionRect.height,\n          background: findBackgroundColor(section),\n          backgroundImages,\n          sourceHasPagination: [content, background, pseudo].some(\n            (node) => node?.hasAttribute("data-marpit-pagination")\n          ),\n          elements: [\n            // Pseudo-element bars (::before/::after) go behind content\n            ...extractPseudoElements(section, sectionRect),\n            ...walkElements(section, sectionRect)\n          ],\n          notes: (section.querySelector("[data-marpit-presenter-notes]") ?? root.querySelector(`.bespoke-marp-note[data-index="${slideIdx}"]`))?.textContent?.trim() ?? ""\n        };\n      }\n    );\n  }\n  return __toCommonJS(dom_walker_exports);\n})();\n\nglobalThis.extractSlides = DomWalker.extractSlides;\n';

// src/native-pptx/slide-builder.ts
var import_node_url = require("node:url");
var import_pptxgenjs = __toESM(require("pptxgenjs"));

// src/native-pptx/utils.ts
function rgbToHex(rgb) {
  if (!rgb) return "000000";
  const match = rgb.match(
    /rgba?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*(?:,\s*[\d.]+\s*)?\)/
  );
  if (!match) return "000000";
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  return [r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("").toUpperCase();
}
var genericFontMap = {
  "sans-serif": "Calibri",
  serif: "Cambria",
  monospace: "Courier New",
  cursive: "Calibri",
  fantasy: "Calibri",
  "ui-sans-serif": "Calibri",
  "ui-serif": "Cambria",
  "ui-monospace": "Courier New"
};
var systemAliases = /* @__PURE__ */ new Set([
  "-apple-system",
  "blinkmacsystemfont",
  "system-ui",
  "ui-rounded",
  "ui-monospace"
]);
var macOnlyFonts = /* @__PURE__ */ new Set([
  "sfmono-regular",
  "sf mono",
  "menlo",
  "sf pro text",
  "sf pro display"
]);
var knownSystemFonts = {
  "segoe ui": "Segoe UI",
  "helvetica neue": "Arial",
  helvetica: "Arial"
};
var japaneseFontPattern = /(noto sans jp|noto sans cjk jp|yu gothic ui|yu gothic|meiryo|biz udpgothic|biz udgothic|ms pgothic|ms gothic|hiragino sans)/i;
var japaneseTextPattern = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff01-\uff9f]/;
var proprietaryFontPattern = /\b\d{2,4}[A-Z]{2,}/i;
function cleanFontFamily(css, sampleText) {
  if (!css) return "Calibri";
  const families = css.split(",");
  let fallback;
  const candidates = [];
  const hasJapaneseText = typeof sampleText === "string" && japaneseTextPattern.test(sampleText);
  for (const raw of families) {
    const name = raw.trim().replace(/^["']|["']$/g, "");
    if (!name) continue;
    const lower = name.toLowerCase();
    if (systemAliases.has(lower)) continue;
    if (macOnlyFonts.has(lower)) continue;
    const known = knownSystemFonts[lower];
    if (known) {
      candidates.push(known);
      continue;
    }
    const generic = genericFontMap[lower];
    if (generic) {
      if (!fallback) fallback = generic;
      continue;
    }
    candidates.push(name);
  }
  if (hasJapaneseText) {
    const japaneseCandidate = candidates.find(
      (candidate) => japaneseFontPattern.test(candidate)
    );
    if (japaneseCandidate) return japaneseCandidate;
    if (candidates.includes("Segoe UI")) return "Yu Gothic UI";
    const nonProprietary = candidates.find(
      (c) => !proprietaryFontPattern.test(c)
    );
    if (nonProprietary) return nonProprietary;
    return "Meiryo";
  }
  if (candidates.length > 0) {
    const safeFront = candidates.find((c) => !proprietaryFontPattern.test(c));
    if (safeFront) return safeFront;
    return candidates[0];
  }
  return fallback ?? "Calibri";
}
function pxToInches(px) {
  return px / 96;
}
function pxToPoints(px) {
  return px * 0.75;
}
function compositeOver(color, bg) {
  const m = color.match(
    /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/
  );
  if (!m) return color;
  const a = parseFloat(m[4]);
  const bgM = bg.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  const bgR = bgM ? parseInt(bgM[1], 10) : 255;
  const bgG = bgM ? parseInt(bgM[2], 10) : 255;
  const bgB = bgM ? parseInt(bgM[3], 10) : 255;
  const cr = Math.round(parseInt(m[1], 10) * a + bgR * (1 - a));
  const cg = Math.round(parseInt(m[2], 10) * a + bgG * (1 - a));
  const cb = Math.round(parseInt(m[3], 10) * a + bgB * (1 - a));
  return `rgb(${cr}, ${cg}, ${cb})`;
}
function isTransparent(color) {
  if (!color) return true;
  if (color === "transparent") return true;
  const match = color.match(
    /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/
  );
  if (match) return parseFloat(match[1]) <= 0.01;
  return false;
}
function sanitizeText(text) {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFEFF\u200B\u200C\u2060\uFE0E\uFE0F]/g,
    ""
  );
}

// src/native-pptx/slide-builder.ts
var DIRECTWRITE_COL_WIDTH_FACTOR = 1.05;
var SLIDE_CANVAS_W_PX = 1280;
function cssBorderStyleToDash(borderStyle) {
  if (!borderStyle || borderStyle === "solid") return void 0;
  if (borderStyle === "dashed") return "dash";
  if (borderStyle === "dotted") return "sysDot";
  return void 0;
}
function resolveImageSource(url) {
  if (url.startsWith("data:")) return { data: url };
  if (url.startsWith("file:")) return { path: (0, import_node_url.fileURLToPath)(url) };
  return { path: url };
}
function computeLineSpacing(style, multiLine) {
  const { lineHeight, fontSize } = style;
  if (!lineHeight || !fontSize || lineHeight <= 0 || fontSize <= 0)
    return void 0;
  const m = lineHeight / fontSize;
  if (m < 0.5 || m > 4) return void 0;
  const divisor = multiLine ? 1.2 : 1.15;
  const adjusted = Math.max(0.85, m / divisor);
  return Math.round(adjusted * 100) / 100;
}
function computeCharSpacing(style) {
  const ls = style.letterSpacing;
  if (!ls || Math.abs(ls) < 0.1) return void 0;
  return Math.round(pxToPoints(ls) * 100) / 100;
}
function computeTextInset(style) {
  const pt = (style.paddingTop ?? 0) * 0.75;
  const pr = (style.paddingRight ?? 0) * 0.75;
  const pb = (style.paddingBottom ?? 0) * 0.75;
  const pl = (style.paddingLeft ?? 0) * 0.75;
  return pt || pr || pb || pl ? [pl, pr, pb, pt] : 0;
}
function createSlideNumberProps(slideW, slideH) {
  const bottomInset = slideH * (30 / 720);
  const rightInset = slideW * (40 / 1280);
  const boxHeight = slideH * (24 / 720);
  const fontSize = slideH * (18 / 720);
  return {
    x: 0,
    y: pxToInches(Math.max(0, slideH - bottomInset - boxHeight)),
    w: pxToInches(Math.max(48, slideW - rightInset)),
    h: pxToInches(Math.max(1, boxHeight)),
    align: "right",
    color: "777777",
    fontSize: Math.round(pxToPoints(fontSize) * 100) / 100,
    margin: 0
  };
}
var DEFAULT_BULLET_INDENT_PT = 27;
function cssListStyleToNumberStyle(cssType) {
  if (!cssType) return void 0;
  switch (cssType) {
    case "decimal":
      return "arabicPeriod";
    case "lower-alpha":
    case "lower-latin":
      return "alphaLcPeriod";
    case "upper-alpha":
    case "upper-latin":
      return "alphaUcPeriod";
    case "lower-roman":
      return "romanLcPeriod";
    case "upper-roman":
      return "romanUcPeriod";
    default:
      return void 0;
  }
}
function cssListStyleToBulletChar(cssType) {
  if (!cssType) return void 0;
  switch (cssType) {
    case "circle":
      return "25E6";
    // ◦ (white bullet — smaller than ○ U+25CB)
    case "square":
      return "25AA";
    // ▪ (black small square)
    case "none":
      return "200B";
    // zero-width space (invisible)
    default:
      return void 0;
  }
}
function createListBulletOption(item, ordered, continuation = false, startNumber, listStyleType) {
  const extraIndent = item.leadingOffset ? pxToPoints(item.leadingOffset) : 0;
  const indent = extraIndent > 0 ? Math.round((DEFAULT_BULLET_INDENT_PT + extraIndent) * 100) / 100 : void 0;
  const effectiveStyle = item.listStyleType ?? listStyleType;
  if (continuation) {
    return {
      characterCode: "200B",
      ...indent !== void 0 ? { indent } : {}
    };
  }
  const isUnorderedStyle = effectiveStyle === "disc" || effectiveStyle === "circle" || effectiveStyle === "square" || effectiveStyle === "none";
  const isOrderedStyle = effectiveStyle === "decimal" || effectiveStyle === "lower-alpha" || effectiveStyle === "lower-latin" || effectiveStyle === "upper-alpha" || effectiveStyle === "upper-latin" || effectiveStyle === "lower-roman" || effectiveStyle === "upper-roman";
  const effectiveOrdered = isUnorderedStyle ? false : isOrderedStyle ? true : ordered;
  if (effectiveOrdered) {
    const numberStyle = cssListStyleToNumberStyle(effectiveStyle) ?? "arabicPeriod";
    return {
      type: "number",
      style: numberStyle,
      ...startNumber !== void 0 ? { numberStartAt: startNumber } : {},
      ...indent !== void 0 ? { indent } : {}
    };
  }
  const bulletChar = cssListStyleToBulletChar(effectiveStyle);
  if (bulletChar) {
    return {
      characterCode: bulletChar,
      ...indent !== void 0 ? { indent } : {}
    };
  }
  return indent !== void 0 ? { indent } : true;
}
function buildPptx(slides) {
  const pptx = new import_pptxgenjs.default();
  const slideW = slides[0]?.width ?? 1280;
  const slideH = slides[0]?.height ?? 720;
  pptx.defineLayout({
    name: "MARP",
    width: pxToInches(slideW),
    height: pxToInches(slideH)
  });
  pptx.layout = "MARP";
  const useSlideNumbers = slides.some((slide) => slide.sourceHasPagination);
  for (const slideData of slides) {
    const slide = pptx.addSlide();
    if (useSlideNumbers) {
      slide.slideNumber = {
        ...createSlideNumberProps(slideW, slideH)
      };
    }
    const bgColor = isTransparent(slideData.background) ? "FFFFFF" : rgbToHex(slideData.background);
    const bgImages = slideData.backgroundImages ?? [];
    const firstBg = bgImages[0];
    const isFullSlide = firstBg && !firstBg.cssFilter && !firstBg.backgroundSizeContain && firstBg.x <= 1 && firstBg.y <= 1 && Math.abs(firstBg.width - slideData.width) <= 2 && Math.abs(firstBg.height - slideData.height) <= 2;
    if (isFullSlide && bgImages.length === 1) {
      slide.background = resolveImageSource(firstBg.url);
    } else {
      slide.background = { fill: bgColor };
      for (const bg of bgImages) {
        const x = pxToInches(bg.x);
        const y = pxToInches(bg.y);
        const w = pxToInches(bg.width);
        const h = pxToInches(bg.height);
        const imgOpts = {
          x,
          y,
          w,
          h,
          ...resolveImageSource(bg.url)
        };
        slide.addImage(imgOpts);
      }
    }
    const cssIsFallbackWhite = !slideData.background || rgbToHex(slideData.background).toUpperCase() === "FFFFFF";
    const visualBgMayBeDark = bgImages.some(
      (bg) => bg.url !== "" && !bg.fromCssFallback && !bg.backgroundSizeContain && bg.width >= slideData.width * 0.8
    ) && cssIsFallbackWhite;
    const slideBgColor = slideData.background ?? "rgb(255, 255, 255)";
    const containerAssoc = associateContainerText(
      slideData.elements,
      slideData.width,
      slideData.height
    );
    const embeddedByContainer = new Set(
      Array.from(containerAssoc.values()).flat()
    );
    const visibleElements = slideData.elements.filter(
      (el) => !TEXT_ELEMENT_TYPES.has(el.type) || slideData.height - el.y >= 20
    );
    const groups = groupAdjacentTextElements(visibleElements);
    for (const group of groups) {
      const active = group.filter((el) => !embeddedByContainer.has(el));
      if (active.length === 0) continue;
      if (active.length === 1) {
        placeElement(
          slide,
          active[0],
          slideData.width,
          slideData.height,
          slideBgColor,
          visualBgMayBeDark,
          containerAssoc
        );
      } else {
        placeGroupedTextElements(
          slide,
          active,
          slideData.width,
          slideData.height,
          slideBgColor,
          visualBgMayBeDark
        );
      }
    }
    if (slideData.notes) {
      slide.addNotes(slideData.notes);
    }
  }
  return pptx;
}
var TEXT_ELEMENT_TYPES = /* @__PURE__ */ new Set([
  "heading",
  "paragraph",
  "list",
  "blockquote",
  "code",
  "table",
  "header",
  "footer"
]);
var GROUPABLE_TYPES = /* @__PURE__ */ new Set([
  "paragraph",
  "blockquote"
]);
var EMBEDDABLE_IN_SHAPE = /* @__PURE__ */ new Set([
  "paragraph",
  "heading",
  "list",
  "blockquote"
]);
function isSimpleTextContainer(el) {
  if (!el.children || el.children.length === 0) return false;
  if (el.runs && el.runs.length > 0) return false;
  if (el.style.borderBottom) return false;
  if (!el.children.every((c) => EMBEDDABLE_IN_SHAPE.has(c.type))) return false;
  if (el.children.length > 1) {
    const xs = el.children.map((c) => c.x);
    const xSpan = Math.max(...xs) - Math.min(...xs);
    if (xSpan > 50) return false;
  }
  return true;
}
function computeContainerInset(el) {
  const { children } = el;
  if (!children || children.length === 0) return 0;
  const firstChild = children[0];
  const lastChild = children[children.length - 1];
  const topPx = Math.max(0, firstChild.y - el.y);
  const leftPx = Math.max(0, firstChild.x - el.x);
  const rightPx = Math.max(
    0,
    el.x + el.width - (firstChild.x + firstChild.width)
  );
  const bottomPx = Math.max(
    0,
    el.y + el.height - (lastChild.y + lastChild.height)
  );
  const top = topPx * 0.75;
  const left = leftPx * 0.75;
  const right = rightPx * 0.75;
  const bottom = bottomPx * 0.75;
  return top || left || right || bottom ? [left, right, bottom, top] : 0;
}
function buildContainerEmbeddedRuns(el, slideBg, visualBgMayBeDark) {
  const toTP = (r) => toTextProps(r, slideBg, visualBgMayBeDark);
  const allRuns = [];
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (i > 0) allRuns.push({ text: "", options: { breakLine: true } });
    if (child.type === "list") {
      const listEl = child;
      let topLevelCount = 0;
      const listRuns = listEl.items.flatMap((item, idx) => {
        const startNum = item.level === 0 && listEl.ordered ? (listEl.startNumber ?? 1) + topLevelCount : void 0;
        if (item.level === 0) topLevelCount++;
        return toListTextProps(
          item,
          listEl.ordered,
          idx < listEl.items.length - 1,
          slideBg,
          visualBgMayBeDark,
          startNum,
          listEl.listStyleType
        );
      });
      allRuns.push(...listRuns);
    } else if ("runs" in child && Array.isArray(child.runs)) {
      allRuns.push(...child.runs.map(toTP));
    }
  }
  return allRuns;
}
var MAX_GROUP_GAP_PX = 64;
var CONTAINMENT_SLOP_PX = 4;
function isContainedIn(text, container) {
  const strict = text.x >= container.x - CONTAINMENT_SLOP_PX && text.y >= container.y - CONTAINMENT_SLOP_PX && text.x + text.width <= container.x + container.width + CONTAINMENT_SLOP_PX && text.y + text.height <= container.y + container.height + CONTAINMENT_SLOP_PX;
  if (strict) return true;
  const dx = Math.abs(text.x - container.x);
  const dy = Math.abs(text.y - container.y);
  const dw = Math.abs(text.width - container.width);
  const dh = Math.abs(text.height - container.height);
  if (dx <= 16 && dy <= 16 && dw <= 16 && dh <= 16) return true;
  return false;
}
function isEmbeddableContainer(el, slideW, slideH) {
  if (el.runs && el.runs.length > 0) return false;
  if (el.style?.borderBottom) return false;
  if (el.children && el.children.length > 0 && !isSimpleTextContainer(el)) {
    return false;
  }
  const hasBackground = !isTransparent(el.style?.backgroundColor);
  const hasBorderLeft = !!(el.style?.borderLeft && el.style.borderLeft.width > 0);
  const hasBorder = (el.style?.borderWidth ?? 0) > 0 && !!el.style?.borderColor && !isTransparent(el.style.borderColor);
  const hasShadow = el.style?.boxShadow === true;
  if (!hasBackground && !hasBorder && !hasShadow && !hasBorderLeft) return false;
  if (slideW > 0 && slideH > 0) {
    if (el.width >= slideW * 0.9 && el.height >= slideH * 0.9) return false;
  }
  return true;
}
function associateContainerText(elements, slideW, slideH) {
  const result = /* @__PURE__ */ new Map();
  const containers = elements.filter(
    (el) => el.type === "container" && isEmbeddableContainer(
      el,
      slideW,
      slideH
    )
  );
  if (containers.length === 0) return result;
  const sorted = [...containers].sort(
    (a, b) => a.width * a.height - b.width * b.height
  );
  const textElements = elements.filter(
    (el) => EMBEDDABLE_IN_SHAPE.has(el.type)
  );
  const assigned = /* @__PURE__ */ new Set();
  for (const container of sorted) {
    const inside = textElements.filter(
      (el) => !assigned.has(el) && isContainedIn(el, container)
    );
    if (inside.length > 0) {
      inside.sort((a, b) => a.y - b.y);
      result.set(container, inside);
      inside.forEach((el) => assigned.add(el));
    }
  }
  return result;
}
function buildRunsFromElements(elements, containerBg, slideBg, visualBgMayBeDark) {
  const toTP = (r) => toTextProps(r, slideBg, visualBgMayBeDark);
  const bgHex = containerBg ? rgbToHex(containerBg) : void 0;
  const allRuns = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (i > 0) allRuns.push({ text: "", options: { breakLine: true } });
    if (el.type === "list") {
      const listEl = el;
      let topLevelCount = 0;
      const listRuns = listEl.items.flatMap((item, idx) => {
        const startNum = item.level === 0 && listEl.ordered ? (listEl.startNumber ?? 1) + topLevelCount : void 0;
        if (item.level === 0) topLevelCount++;
        return toListTextProps(
          item,
          listEl.ordered,
          idx < listEl.items.length - 1,
          slideBg,
          visualBgMayBeDark,
          startNum,
          listEl.listStyleType
        );
      });
      allRuns.push(...listRuns);
    } else if ("runs" in el && Array.isArray(el.runs)) {
      const runs = el.runs;
      const mapped = runs.map((r) => {
        if (bgHex && !r.breakLine && r.backgroundColor && rgbToHex(r.backgroundColor) === bgHex) {
          return { ...r, backgroundColor: void 0 };
        }
        return r;
      });
      allRuns.push(...mapped.map(toTP));
    }
  }
  return allRuns;
}
function computeInsetFromElements(container, elements) {
  if (elements.length === 0) return 0;
  const firstEl = elements[0];
  const lastEl = elements[elements.length - 1];
  const topPx = Math.max(0, firstEl.y - container.y);
  const leftPx = Math.max(
    0,
    Math.min(...elements.map((e) => e.x - container.x))
  );
  const rightPx = Math.max(
    0,
    Math.min(
      ...elements.map(
        (e) => container.x + container.width - (e.x + e.width)
      )
    )
  );
  const bottomPx = Math.max(
    0,
    container.y + container.height - (lastEl.y + lastEl.height)
  );
  const top = topPx * 0.75;
  const left = leftPx * 0.75;
  const right = rightPx * 0.75;
  const bottom = bottomPx * 0.75;
  return top || left || right || bottom ? [left, right, bottom, top] : 0;
}
var MAX_X_DIFF_PX = 5;
var MAX_WIDTH_DIFF_PX = 5;
function canMergeElements(a, b) {
  if (!GROUPABLE_TYPES.has(a.type) || !GROUPABLE_TYPES.has(b.type)) return false;
  if (a.type === "paragraph" && "style" in a) {
    const s = a.style;
    if (s.lineHeight > 0 && a.height > s.lineHeight * 1.5) return false;
  }
  if (b.type === "paragraph" && "style" in b) {
    const s = b.style;
    if (s.lineHeight > 0 && b.height > s.lineHeight * 1.5) return false;
  }
  if (Math.abs(a.x - b.x) > MAX_X_DIFF_PX) return false;
  if (Math.abs(a.width - b.width) > MAX_WIDTH_DIFF_PX) return false;
  const gap = b.y - (a.y + a.height);
  if (gap < 0 || gap > MAX_GROUP_GAP_PX) return false;
  if (a.type === "heading" && ("borderBottom" in a || "borderLeft" in a)) {
    const h = a;
    if (h.borderBottom && h.borderBottom.width > 0 || h.borderLeft && h.borderLeft.width > 0) return false;
  }
  if (b.type === "heading" && ("borderBottom" in b || "borderLeft" in b)) {
    const h = b;
    if (h.borderBottom && h.borderBottom.width > 0 || h.borderLeft && h.borderLeft.width > 0) return false;
  }
  if (a.type === "blockquote" && "borderLeft" in a) {
    const bq = a;
    if (bq.borderLeft && bq.borderLeft.width > 0) return false;
  }
  if (b.type === "blockquote" && "borderLeft" in b) {
    const bq = b;
    if (bq.borderLeft && bq.borderLeft.width > 0) return false;
  }
  return true;
}
function groupAdjacentTextElements(elements) {
  if (elements.length === 0) return [];
  const groups = [[elements[0]]];
  for (let i = 1; i < elements.length; i++) {
    const current = elements[i];
    const lastGroup = groups[groups.length - 1];
    const lastEl = lastGroup[lastGroup.length - 1];
    if (canMergeElements(lastEl, current)) {
      lastGroup.push(current);
    } else {
      groups.push([current]);
    }
  }
  return groups;
}
function computeHighlight(backgroundColor, textColor, slideBg, visualBgMayBeDark = false) {
  if (!backgroundColor) return void 0;
  const composited = compositeOver(backgroundColor, slideBg);
  const hex = rgbToHex(composited);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const bghex = rgbToHex(slideBg);
  const br = parseInt(bghex.slice(0, 2), 16);
  const bgG = parseInt(bghex.slice(2, 4), 16);
  const bgB = parseInt(bghex.slice(4, 6), 16);
  if (Math.max(Math.abs(r - br), Math.abs(g - bgG), Math.abs(b - bgB)) < 10)
    return void 0;
  if (visualBgMayBeDark && r > 200 && g > 200 && b > 200) return void 0;
  if (r > 200 && g > 200 && b > 200 && textColor) {
    const tc = rgbToHex(textColor);
    const tr = parseInt(tc.slice(0, 2), 16);
    const tg = parseInt(tc.slice(2, 4), 16);
    const tb = parseInt(tc.slice(4, 6), 16);
    if (tr > 200 && tg > 200 && tb > 200) return void 0;
  }
  return hex;
}
function placeElement(slide, el, slideW = 0, slideH = 0, slideBg = "rgb(255, 255, 255)", visualBgMayBeDark = false, containerAssoc) {
  if (slideH > 0 && TEXT_ELEMENT_TYPES.has(el.type) && slideH - el.y < 20) return;
  const x = pxToInches(el.x);
  const y = pxToInches(el.y);
  const w = pxToInches(el.width);
  const rawH = pxToInches(el.height);
  const h = slideH > 0 && TEXT_ELEMENT_TYPES.has(el.type) ? Math.min(rawH, Math.max(0.01, pxToInches(slideH) - y)) : rawH;
  const toTP = (r) => toTextProps(r, slideBg, visualBgMayBeDark);
  const elLineHeight = "style" in el && "lineHeight" in el.style ? el.style.lineHeight : 0;
  const isMultiLine = elLineHeight > 0 && el.height > elLineHeight * 1.5;
  switch (el.type) {
    case "heading": {
      const headingBorderW = el.borderLeft && el.borderLeft.width > 0 ? pxToInches(el.borderLeft.width) : 0;
      if (headingBorderW > 0) {
        slide.addShape("rect", {
          x,
          y,
          w: headingBorderW,
          h,
          fill: { color: rgbToHex(el.borderLeft.color) },
          line: { color: rgbToHex(el.borderLeft.color) }
        });
      }
      const isFullWidthHeading = slideW > 0 && el.x < slideW * 0.15 && el.x + el.width > slideW * 0.85;
      const headingTextW = isFullWidthHeading ? Math.max(0.01, pxToInches(slideW - el.x - 16) - headingBorderW) : slideW > 0 ? Math.max(
        0.01,
        pxToInches(
          Math.min(
            el.width * DIRECTWRITE_COL_WIDTH_FACTOR,
            slideW - el.x
          )
        ) - headingBorderW
      ) : Math.max(0.01, w - headingBorderW);
      const headingInset = computeTextInset(el.style);
      const headingHalfLeading = el.style.lineHeight > 0 && el.style.fontSize > 0 ? (el.style.lineHeight - el.style.fontSize) / 2 : 0;
      const headingY = headingHalfLeading > 0 ? pxToInches(el.y - headingHalfLeading) : y;
      slide.addText(
        el.runs.map(toTP),
        {
          x: x + headingBorderW,
          y: headingY,
          w: headingTextW,
          h,
          margin: headingInset,
          valign: "top",
          align: el.style.textAlign,
          lineSpacingMultiple: computeLineSpacing(el.style, isMultiLine),
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
          charSpacing: computeCharSpacing(el.style)
        }
      );
      if (el.borderBottom && el.borderBottom.width > 0) {
        const bh = pxToInches(el.borderBottom.width);
        const bbColor = rgbToHex(el.borderBottom.color);
        const bbDash = cssBorderStyleToDash(el.borderBottom.style);
        slide.addShape("rect", {
          x,
          y: y + h,
          w,
          h: bh,
          ...bbDash ? {
            line: {
              color: bbColor,
              width: Math.max(0.25, pxToPoints(el.borderBottom.width)),
              dashType: bbDash
            }
          } : {
            fill: { color: bbColor },
            line: { color: bbColor, width: 0.25 }
          }
        });
      }
      break;
    }
    case "paragraph": {
      const noWrap = el.style.whiteSpace === "nowrap";
      const isSingleLine = el.style.lineHeight > 0 && el.height <= el.style.lineHeight * 1.5;
      let paraW;
      if (noWrap) {
        paraW = slideW > 0 ? Math.max(w, pxToInches(Math.min(el.width * 1.15, slideW - el.x))) : w;
      } else if (slideW > 0 && isSingleLine) {
        const extendedW = el.width * DIRECTWRITE_COL_WIDTH_FACTOR;
        const maxW = slideW - el.x - 4;
        paraW = Math.max(w, pxToInches(Math.min(extendedW, maxW)));
      } else {
        paraW = w;
      }
      const paraHalfLeading = el.style.lineHeight > 0 && el.style.fontSize > 0 ? (el.style.lineHeight - el.style.fontSize) / 2 : 0;
      const paraY = paraHalfLeading > 0 ? pxToInches(el.y - paraHalfLeading) : y;
      slide.addText(
        el.runs.map(toTP),
        {
          x,
          y: paraY,
          w: paraW,
          h,
          margin: computeTextInset(el.style),
          valign: el.valign ?? "top",
          align: el.style.textAlign,
          lineSpacingMultiple: computeLineSpacing(el.style, isMultiLine),
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
          charSpacing: computeCharSpacing(el.style),
          ...noWrap ? { wrap: false } : {}
        }
      );
      break;
    }
    case "header":
    case "footer":
      slide.addText(
        el.runs.map(toTP),
        {
          x,
          y,
          w,
          h,
          margin: 0,
          valign: "top",
          align: el.style.textAlign,
          lineSpacingMultiple: computeLineSpacing(el.style, isMultiLine),
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
          charSpacing: computeCharSpacing(el.style)
        }
      );
      break;
    case "blockquote":
      if (el.borderLeft && el.borderLeft.width > 0) {
        const bw = pxToInches(el.borderLeft.width);
        slide.addShape("rect", {
          x,
          y,
          w: bw,
          h,
          fill: { color: rgbToHex(el.borderLeft.color) }
        });
        slide.addText(
          el.runs.map(toTP),
          {
            x: x + bw,
            y,
            w: w - bw,
            h,
            margin: computeTextInset(el.style),
            valign: "top",
            align: el.style.textAlign,
            lineSpacingMultiple: computeLineSpacing(el.style, isMultiLine),
            paraSpaceBefore: 0,
            paraSpaceAfter: 0,
            charSpacing: computeCharSpacing(el.style)
          }
        );
      } else {
        slide.addText(
          el.runs.map(toTP),
          {
            x,
            y,
            w,
            h,
            margin: computeTextInset(el.style),
            valign: "top",
            align: el.style.textAlign,
            lineSpacingMultiple: computeLineSpacing(el.style, isMultiLine),
            paraSpaceBefore: 0,
            paraSpaceAfter: 0,
            charSpacing: computeCharSpacing(el.style)
          }
        );
      }
      break;
    case "list": {
      const halfLeadingPx = el.style.lineHeight > 0 && el.style.fontSize > 0 ? (el.style.lineHeight - el.style.fontSize) / 2 : 0;
      const yShiftPx = halfLeadingPx * 1;
      const listY = pxToInches(el.y - yShiftPx);
      const listH = Math.max(0.01, h + pxToInches(yShiftPx));
      let topLevelCount = 0;
      slide.addText(
        el.items.flatMap((item, index) => {
          const startNum = item.level === 0 && el.ordered ? (el.startNumber ?? 1) + topLevelCount : void 0;
          if (item.level === 0) topLevelCount++;
          return toListTextProps(
            item,
            el.ordered,
            index < el.items.length - 1,
            slideBg,
            visualBgMayBeDark,
            startNum,
            el.listStyleType
          );
        }),
        {
          x,
          y: listY,
          w,
          h: listH,
          margin: 0,
          valign: "top",
          align: el.style.textAlign,
          lineSpacingMultiple: computeLineSpacing(el.style, isMultiLine),
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
          charSpacing: computeCharSpacing(el.style)
        }
      );
      break;
    }
    case "table": {
      const refCell = el.rows[0]?.cells[0];
      const hasCellPadding = refCell?.style.paddingTop !== void 0 && refCell?.style.paddingTop !== null;
      const tableFallbackMargin = hasCellPadding ? [
        pxToInches(refCell.style.paddingTop),
        pxToInches(refCell.style.paddingRight ?? 0),
        pxToInches(refCell.style.paddingBottom ?? 0),
        pxToInches(refCell.style.paddingLeft ?? 0)
      ] : [0.1, 0.05, 0.1, 0.05];
      slide.addTable(
        el.rows.map(
          (row) => row.cells.map((cell) => {
            const cellMargin = cell.style.paddingTop !== void 0 ? [
              pxToInches(cell.style.paddingTop ?? 0),
              pxToInches(cell.style.paddingRight ?? 0),
              pxToInches(cell.style.paddingBottom ?? 0),
              pxToInches(cell.style.paddingLeft ?? 0)
            ] : void 0;
            if (cell.runs && cell.runs.length > 0) {
              const cellOpts2 = {
                align: cell.style.textAlign,
                ...cellMargin ? { margin: cellMargin } : {},
                ...cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {},
                ...cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}
              };
              if (!isTransparent(cell.style.backgroundColor)) {
                cellOpts2.fill = { color: rgbToHex(cell.style.backgroundColor) };
              }
              if (cell.style.borderColor && !isTransparent(cell.style.borderColor)) {
                cellOpts2.border = {
                  pt: 1,
                  color: rgbToHex(cell.style.borderColor)
                };
              }
              const cellEffBg = !isTransparent(cell.style.backgroundColor) ? cell.style.backgroundColor : slideBg;
              const runToTextProp = (r) => {
                const hl = computeHighlight(
                  r.backgroundColor,
                  r.color,
                  cellEffBg,
                  visualBgMayBeDark
                );
                return {
                  text: sanitizeText(r.text),
                  options: {
                    color: rgbToHex(r.color),
                    fontSize: pxToPoints(r.fontSize ?? cell.style.fontSize),
                    fontFace: cleanFontFamily(
                      r.fontFamily ?? cell.style.fontFamily,
                      r.text
                    ),
                    bold: r.bold ?? cell.isHeader ?? cell.style.fontWeight >= 600,
                    italic: r.italic,
                    ...hl ? { highlight: hl } : {}
                  }
                };
              };
              let textArray;
              if (cell.paragraphs && cell.paragraphs.length > 0) {
                textArray = cell.paragraphs.flatMap((para, pIdx) => {
                  const paraRuns = para.runs.filter((r) => !r.breakLine).map(runToTextProp);
                  if (paraRuns.length === 0) {
                    paraRuns.push({ text: " ", options: {
                      fontSize: pxToPoints(cell.style.fontSize)
                    } });
                  }
                  if (pIdx < cell.paragraphs.length - 1) {
                    const last = paraRuns[paraRuns.length - 1];
                    paraRuns[paraRuns.length - 1] = {
                      ...last,
                      options: { ...last.options, breakLine: true }
                    };
                  }
                  return paraRuns;
                });
              } else {
                textArray = cell.runs.map((r) => {
                  if (r.breakLine) {
                    return { text: "", options: { breakLine: true } };
                  }
                  return runToTextProp(r);
                });
              }
              return {
                text: textArray,
                options: cellOpts2
              };
            }
            const cellOpts = {
              bold: cell.isHeader || cell.style.fontWeight >= 600,
              color: rgbToHex(cell.style.color),
              fontSize: pxToPoints(cell.style.fontSize),
              fontFace: cleanFontFamily(cell.style.fontFamily, cell.text),
              align: cell.style.textAlign,
              ...cellMargin ? { margin: cellMargin } : {},
              ...cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {},
              ...cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}
            };
            if (!isTransparent(cell.style.backgroundColor)) {
              cellOpts.fill = { color: rgbToHex(cell.style.backgroundColor) };
            }
            if (cell.style.borderColor && !isTransparent(cell.style.borderColor)) {
              cellOpts.border = {
                pt: 1,
                color: rgbToHex(cell.style.borderColor)
              };
            }
            return { text: sanitizeText(cell.text), options: cellOpts };
          })
        ),
        {
          x,
          y,
          w,
          autoPage: false,
          // Preserve HTML column proportions when per-column widths are available
          ...el.colWidths && el.colWidths.length > 0 && el.colWidths.every((cw) => cw > 0) ? {
            // Add a proportional per-column slack to absorb PPTX/Chrome
            // font-metric variance.  DirectWrite (PPTX) renders bold text
            // slightly wider than Chrome's Skia.  A fixed absolute slack
            // was insufficient for longer header strings (e.g. "Column 2
            // (center-aligned)") where the absolute pixel variance at the
            // DirectWrite level can exceed 8 px.  Scaling each column to
            // 105% of the browser-measured width covers the observed ~3%
            // variance across all header cell lengths and font sizes while
            // adding a manageable ~5% total table width overhead.
            // Guard: if scaled column total would exceed the table width,
            // scale back proportionally so the table fits within the slide.
            colW: (() => {
              const scaled = el.colWidths.map((cw) => cw * DIRECTWRITE_COL_WIDTH_FACTOR);
              const scaledSum = scaled.reduce((a, b) => a + b, 0);
              const available = SLIDE_CANVAS_W_PX - el.x;
              const clamp = scaledSum > available ? available / scaledSum : 1;
              return scaled.map((cw) => pxToInches(cw * clamp));
            })()
          } : {},
          // Cell margin derived from CSS padding of the first cell.
          // Per-cell margins (set above) override this when available.
          // Fallback matches Marp's default table cell CSS padding.
          margin: tableFallbackMargin
        }
      );
      break;
    }
    case "code": {
      const hasCodeBg = !isTransparent(el.style.backgroundColor);
      const codeShapeOpts = {
        x,
        y,
        w,
        h,
        margin: 0,
        valign: "top",
        paraSpaceBefore: 0,
        paraSpaceAfter: 0,
        autoFit: false,
        wrap: false,
        ...hasCodeBg ? {
          shape: "rect",
          fill: { color: rgbToHex(el.style.backgroundColor) }
        } : {}
      };
      const LINE_SPACING = 1.2;
      const codeNumLines = el.runs ? el.runs.filter((r) => r.breakLine).length + 1 : el.text?.split("\n").length ?? 1;
      const shapeHeightPt = h * 72;
      const baseFontSizePt = pxToPoints(el.style.fontSize);
      const maxFontSizePt = codeNumLines > 1 ? shapeHeightPt / (codeNumLines * LINE_SPACING) : shapeHeightPt;
      const codeFontScale = baseFontSizePt > maxFontSizePt ? maxFontSizePt / baseFontSizePt : 1;
      const codeFontFace = cleanFontFamily(
        el.style.fontFamily,
        el.text
      );
      if (el.runs && el.runs.length > 0) {
        slide.addText(
          el.runs.map((r) => {
            if (r.breakLine) {
              return { text: "", options: { breakLine: true } };
            }
            return {
              text: sanitizeText(r.text),
              options: {
                color: rgbToHex(r.color),
                fontSize: pxToPoints(r.fontSize ?? el.style.fontSize) * codeFontScale,
                fontFace: codeFontFace,
                bold: r.bold,
                italic: r.italic
              }
            };
          }),
          codeShapeOpts
        );
      } else {
        slide.addText(sanitizeText(el.text), {
          ...codeShapeOpts,
          fontFace: codeFontFace,
          fontSize: pxToPoints(el.style.fontSize) * codeFontScale,
          color: rgbToHex(el.style.color)
        });
      }
      break;
    }
    case "image": {
      const imgOpts = {
        x,
        y,
        w,
        h,
        ...resolveImageSource(el.src)
      };
      slide.addImage(imgOpts);
      break;
    }
    case "container": {
      const bg = el.style?.backgroundColor;
      const borderWidth = el.style?.borderWidth ?? 0;
      const borderColor = el.style?.borderColor;
      const borderRadius = el.style?.borderRadius ?? 0;
      const borderLeft = el.style?.borderLeft;
      const hasBoxShadow = el.style?.boxShadow === true;
      const hasBackground = !isTransparent(bg);
      const hasBorder = borderWidth > 0 && !!borderColor && !isTransparent(borderColor);
      const borderDashType = cssBorderStyleToDash(el.style?.borderStyle);
      const lineStyle = hasBorder ? {
        color: rgbToHex(borderColor),
        width: pxToPoints(borderWidth),
        ...borderDashType ? { dashType: borderDashType } : {}
      } : hasBoxShadow ? { color: "CCCCCC", width: 0.5 } : void 0;
      const shapeType = borderRadius > 0 ? "roundRect" : "rect";
      const minDim = Math.min(el.width, el.height);
      const rectRadius = borderRadius > 0 ? Math.min(0.5, borderRadius / (minDim / 2)) : void 0;
      const isVisibleShape = hasBackground || hasBorder || hasBoxShadow;
      const spatialText = containerAssoc?.get(
        el
      );
      const useEmbeddedPath = isVisibleShape && (spatialText && spatialText.length > 0 || isSimpleTextContainer(el));
      if (useEmbeddedPath) {
        let runs;
        let margin;
        let firstStyle;
        if (spatialText && spatialText.length > 0) {
          runs = buildRunsFromElements(
            spatialText,
            hasBackground ? bg : void 0,
            slideBg,
            visualBgMayBeDark
          );
          margin = computeInsetFromElements(
            el,
            spatialText
          );
          const firstEl = spatialText[0];
          firstStyle = "style" in firstEl ? firstEl.style : void 0;
        } else {
          if (hasBackground) {
            const bgHex = rgbToHex(bg);
            for (const child of el.children) {
              if ("runs" in child && Array.isArray(child.runs)) {
                for (const r of child.runs) {
                  if (!r.breakLine && r.backgroundColor && rgbToHex(r.backgroundColor) === bgHex) {
                    r.backgroundColor = void 0;
                  }
                }
              }
            }
          }
          runs = buildContainerEmbeddedRuns(el, slideBg, visualBgMayBeDark);
          margin = computeContainerInset(el);
          const firstChild = el.children[0];
          firstStyle = "style" in firstChild ? firstChild.style : void 0;
        }
        const borderLeft2 = el.style?.borderLeft;
        if (borderLeft2 && borderLeft2.width > 0) {
          const extraLeft = borderLeft2.width * 0.75 + 2;
          if (Array.isArray(margin)) {
            margin = [margin[0] + extraLeft, margin[1], margin[2], margin[3]];
          } else {
            margin = [extraLeft, 0, 0, 0];
          }
        }
        const isBadgeLike = el.width <= 80 && el.height <= 80 && borderRadius >= 50;
        slide.addText(runs, {
          shape: shapeType,
          x,
          y,
          w,
          h,
          fill: hasBackground ? { color: rgbToHex(bg) } : { type: "none" },
          ...lineStyle ? { line: lineStyle } : {},
          ...rectRadius !== void 0 ? { rectRadius } : {},
          margin,
          valign: isBadgeLike ? "middle" : "top",
          align: isBadgeLike ? "center" : firstStyle?.textAlign,
          lineSpacingMultiple: isBadgeLike ? 1 : firstStyle ? computeLineSpacing(firstStyle) : void 0,
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
          charSpacing: firstStyle ? computeCharSpacing(firstStyle) : void 0,
          autoFit: false,
          wrap: true
        });
        if (borderLeft2 && borderLeft2.width > 0) {
          const bw = pxToInches(borderLeft2.width);
          const blColor = rgbToHex(borderLeft2.color);
          slide.addShape("rect", {
            x,
            y,
            w: bw,
            h,
            fill: { color: blColor },
            line: { color: blColor, width: 0.25 }
          });
        }
        break;
      }
      const hasBadgeRuns = el.runs && el.runs.length > 0 && el.runs.some((r) => !r.breakLine && r.text.trim() !== "");
      if (hasBadgeRuns && isVisibleShape) {
        slide.addText(
          el.runs.map(toTP),
          {
            shape: shapeType,
            x,
            y,
            w,
            h,
            fill: hasBackground ? { color: rgbToHex(bg) } : { type: "none" },
            ...lineStyle ? { line: lineStyle } : {},
            ...rectRadius !== void 0 ? { rectRadius } : {},
            margin: 0,
            valign: "middle",
            align: "center",
            lineSpacingMultiple: 1,
            paraSpaceBefore: 0,
            paraSpaceAfter: 0
          }
        );
        break;
      }
      if (isVisibleShape) {
        slide.addShape(shapeType, {
          x,
          y,
          w,
          h,
          fill: hasBackground ? { color: rgbToHex(bg) } : { type: "none" },
          ...lineStyle ? { line: lineStyle } : {},
          ...rectRadius !== void 0 ? { rectRadius } : {}
        });
      }
      if (borderLeft && borderLeft.width > 0) {
        const bw = pxToInches(borderLeft.width);
        slide.addShape("rect", {
          x,
          y,
          w: bw,
          h,
          fill: { color: rgbToHex(borderLeft.color) },
          line: { color: rgbToHex(borderLeft.color) }
        });
      }
      const borderBottom = el.style?.borderBottom;
      if (borderBottom && borderBottom.width > 0) {
        const bbh = pxToInches(borderBottom.width);
        const bbColor = rgbToHex(borderBottom.color);
        const bbDash = cssBorderStyleToDash(borderBottom.style);
        slide.addShape("rect", {
          x,
          y: y + h,
          w,
          h: bbh,
          // For dashed/dotted borders: omit fill so PptxGenJS generates
          // <a:noFill/>.  Passing fill:{type:'none'} is a truthy object and
          // routes through genXmlColorSelection() which only handles 'solid' —
          // it outputs nothing, leaving the shape with the slide-theme default
          // fill (potentially opaque) which would mask the dash pattern.
          // Omitting fill makes options.fill falsy → PptxGenJS emits <a:noFill/>.
          // For solid borders, a filled rect renders cleanly as a solid rule.
          ...bbDash ? {
            line: {
              color: bbColor,
              width: Math.max(0.25, pxToPoints(borderBottom.width)),
              dashType: bbDash
            }
          } : {
            fill: { color: bbColor },
            line: { color: bbColor, width: 0.25 }
          }
        });
      }
      if (hasBackground) {
        const bgHex = rgbToHex(bg);
        for (const child of el.children ?? []) {
          if ("runs" in child && Array.isArray(child.runs)) {
            for (const r of child.runs) {
              if (!r.breakLine && r.backgroundColor && rgbToHex(r.backgroundColor) === bgHex) {
                r.backgroundColor = void 0;
              }
            }
          }
        }
      }
      const childElements = el.children ?? [];
      const childAssoc = associateContainerText(
        childElements,
        slideW,
        slideH
      );
      const childEmbedded = new Set(
        Array.from(childAssoc.values()).flat()
      );
      for (const child of childElements) {
        if (childEmbedded.has(child)) continue;
        placeElement(
          slide,
          child,
          slideW,
          slideH,
          slideBg,
          visualBgMayBeDark,
          childAssoc
        );
      }
      break;
    }
  }
}
function placeGroupedTextElements(slide, group, slideW, slideH, slideBg, visualBgMayBeDark) {
  const minX = Math.min(...group.map((e) => e.x));
  const minY = Math.min(...group.map((e) => e.y));
  const maxX = Math.max(...group.map((e) => e.x + e.width));
  const maxY = Math.max(...group.map((e) => e.y + e.height));
  const x = pxToInches(minX);
  const firstStyle = "style" in group[0] ? group[0].style : void 0;
  const groupHalfLeading = firstStyle && firstStyle.lineHeight > 0 && firstStyle.fontSize > 0 ? (firstStyle.lineHeight - firstStyle.fontSize) / 2 : 0;
  const y = pxToInches(minY - groupHalfLeading);
  const w = pxToInches(maxX - minX);
  const h = slideH > 0 ? Math.min(pxToInches(maxY - minY), Math.max(0.01, pxToInches(slideH) - y)) : pxToInches(maxY - minY);
  const toTP = (r) => toTextProps(r, slideBg, visualBgMayBeDark);
  const allRuns = [];
  for (let i = 0; i < group.length; i++) {
    const el = group[i];
    if (i > 0) {
      allRuns.push({ text: "", options: { breakLine: true } });
    }
    if (el.type === "list") {
      const listEl = el;
      let topLevelCount = 0;
      const listRuns = listEl.items.flatMap((item, idx) => {
        const startNum = item.level === 0 && listEl.ordered ? (listEl.startNumber ?? 1) + topLevelCount : void 0;
        if (item.level === 0) topLevelCount++;
        return toListTextProps(
          item,
          listEl.ordered,
          idx < listEl.items.length - 1,
          slideBg,
          visualBgMayBeDark,
          startNum,
          listEl.listStyleType
        );
      });
      allRuns.push(...listRuns);
    } else if ("runs" in el && Array.isArray(el.runs)) {
      allRuns.push(...el.runs.map(toTP));
    }
  }
  const first = group[0];
  const style = "style" in first ? first.style : void 0;
  slide.addText(allRuns, {
    x,
    y,
    w,
    h,
    margin: style ? computeTextInset(style) : 0,
    valign: "top",
    align: style?.textAlign,
    lineSpacingMultiple: style ? computeLineSpacing(style) : void 0,
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    charSpacing: style ? computeCharSpacing(style) : void 0
  });
}
function toTextProps(run, slideBg = "rgb(255, 255, 255)", visualBgMayBeDark = false) {
  if (run.breakLine) {
    return { text: "", options: { breakLine: true } };
  }
  const text = sanitizeText(run.text);
  const highlight = computeHighlight(
    run.backgroundColor,
    run.color,
    slideBg,
    visualBgMayBeDark
  );
  return {
    text,
    options: {
      color: rgbToHex(run.color),
      fontSize: pxToPoints(run.fontSize ?? 16),
      fontFace: cleanFontFamily(run.fontFamily, run.text),
      bold: run.bold,
      italic: run.italic,
      underline: run.underline ? { style: "sng" } : void 0,
      strike: run.strikethrough ? "sngStrike" : void 0,
      subscript: run.subscript || void 0,
      superscript: run.superscript || void 0,
      hyperlink: run.hyperlink ? { url: run.hyperlink } : void 0,
      highlight
    }
  };
}
function toListTextProps(item, ordered = false, breakAfter = false, slideBg = "rgb(255, 255, 255)", visualBgMayBeDark = false, startNumber, listStyleType) {
  const bulletOption = createListBulletOption(item, ordered, false, startNumber, listStyleType);
  if (item.runs.length === 0) {
    return [
      {
        text: sanitizeText(item.text) || " ",
        options: {
          bullet: bulletOption,
          indentLevel: item.level,
          breakLine: breakAfter
        }
      }
    ];
  }
  const groups = [[]];
  for (const run of item.runs) {
    if (run.breakLine) {
      groups.push([]);
    } else {
      groups[groups.length - 1].push(run);
    }
  }
  const result = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group.length === 0) continue;
    const isContinuation = g > 0;
    const isLastGroup = g === groups.length - 1;
    const groupBullet = isContinuation ? createListBulletOption(item, ordered, true, void 0, listStyleType) : bulletOption;
    for (let r = 0; r < group.length; r++) {
      const run = group[r];
      const isLastRun = r === group.length - 1;
      const needsBreakLine = isLastRun && (!isLastGroup || breakAfter);
      result.push({
        text: sanitizeText(run.text),
        options: {
          // Always propagate bullet and indentLevel to every run in the group.
          // PptxGenJS v4.x emits <a:pPr> for each TextProp in the same
          // paragraph. LibreOffice uses the *last* <a:pPr>, so without
          // propagation the last run's pPr resets the bullet with <a:buNone/>.
          // PowerPoint uses the *first* <a:pPr> and is unaffected by this change.
          bullet: groupBullet,
          indentLevel: item.level,
          ...needsBreakLine ? { breakLine: true } : {},
          color: rgbToHex(run.color),
          fontSize: pxToPoints(run.fontSize ?? 16),
          fontFace: cleanFontFamily(run.fontFamily, run.text),
          bold: run.bold,
          italic: run.italic,
          subscript: run.subscript || void 0,
          superscript: run.superscript || void 0,
          highlight: computeHighlight(
            run.backgroundColor,
            run.color,
            slideBg,
            visualBgMayBeDark
          )
        }
      });
    }
  }
  return result;
}

// src/native-pptx/index.ts
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function shouldHidePaginationPseudoText(rawContent, paginationValue, paginationTotal) {
  const normalizedPaginationValue = paginationValue?.trim();
  if (!normalizedPaginationValue) return false;
  const normalizedContent = rawContent?.trim();
  if (!normalizedContent || normalizedContent === "none" || normalizedContent === "normal") {
    return false;
  }
  const strippedContent = normalizedContent.replace(/^['"]|['"]$/g, "").trim();
  if (!strippedContent) return false;
  const escapedPaginationValue = escapeRegExp(normalizedPaginationValue);
  const normalizedPaginationTotal = paginationTotal?.trim();
  const exactValuePattern = new RegExp(`^\\(?0*${escapedPaginationValue}\\)?$`);
  if (exactValuePattern.test(strippedContent)) return true;
  const labeledValuePattern = new RegExp(
    `^(?:page|slide|p\\.?|#)\\s*0*${escapedPaginationValue}$`,
    "i"
  );
  if (labeledValuePattern.test(strippedContent)) return true;
  if (!normalizedPaginationTotal) return false;
  const escapedPaginationTotal = escapeRegExp(normalizedPaginationTotal);
  const pagedFractionPattern = new RegExp(
    `^(?:(?:page|slide|p\\.?|#)\\s*)?0*${escapedPaginationValue}\\s*(?:/|of)\\s*0*${escapedPaginationTotal}$`,
    "i"
  );
  return pagedFractionPattern.test(strippedContent);
}
async function generateNativePptx(opts) {
  const { htmlPath, browserPath, width = 1280, height = 720 } = opts;
  let browser;
  try {
    browser = await import_puppeteer_core.default.launch({
      executablePath: browserPath,
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
    const chromeProcess = browser.process();
    if (chromeProcess && typeof chromeProcess.pid === "number") {
      console.log(`[deckd] chrome-pid: ${chromeProcess.pid}`);
    }
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    const fileUrl = (0, import_node_url2.pathToFileURL)(htmlPath).href;
    await page.goto(fileUrl, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1e3));
    await page.addStyleTag({
      content: "*,*::before,*::after{animation:none!important;transition:none!important}"
    });
    await page.addStyleTag({
      content: ".bespoke-marp-osc,[data-bespoke-marp-osc],.bespoke-marp-note{display:none!important}"
    });
    await page.addScriptTag({ content: DOM_WALKER_SCRIPT });
    const slides = await page.evaluate(
      () => globalThis.extractSlides()
    );
    if (slides.some((slide) => slide.sourceHasPagination)) {
      const paginationMatches = await page.evaluate(
        () => Array.from(
          document.querySelectorAll("section[data-marpit-pagination]")
        ).map((section, index) => ({
          index,
          paginationValue: section.getAttribute("data-marpit-pagination")?.trim() ?? "",
          paginationTotal: section.getAttribute("data-marpit-pagination-total")?.trim() ?? "",
          afterContent: getComputedStyle(section, "::after").content ?? ""
        }))
      );
      const matchedPaginationIndexes = paginationMatches.filter(
        ({ afterContent, paginationValue, paginationTotal }) => shouldHidePaginationPseudoText(
          afterContent,
          paginationValue,
          paginationTotal
        )
      ).map(({ index }) => index);
      if (matchedPaginationIndexes.length > 0) {
        await page.evaluate((matchedIndexes) => {
          const sections = Array.from(
            document.querySelectorAll("section[data-marpit-pagination]")
          );
          for (const index of matchedIndexes) {
            sections[index]?.setAttribute(
              "data-native-pptx-hide-pagination-after",
              "true"
            );
          }
        }, matchedPaginationIndexes);
        await page.addStyleTag({
          content: 'section[data-native-pptx-hide-pagination-after="true"]::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}'
        });
      }
    }
    const missingUrls = await findMissingLocalUrls(slides);
    await rasterizeSlideTargets(page, buildBrokenContentImageJobs(slides, missingUrls));
    pruneMissingBackgrounds(slides, missingUrls);
    await rasterizeSlideTargets(page, buildFilteredBgJobs(slides));
    await rasterizeSlideTargets(page, buildCssFallbackBgJobs(slides));
    await rasterizeSlideTargets(page, buildFilteredContentImageJobs(slides));
    await rasterizeSlideTargets(page, buildRasterizeImageJobs(slides));
    await rasterizeSlideTargets(page, buildPartialBgJobs(slides));
    if (opts.debugJsonPath) {
      await (0, import_promises.writeFile)(
        opts.debugJsonPath,
        JSON.stringify(slides, null, 2),
        "utf-8"
      );
    }
    await resolveImageUrls(slides);
    const pptx = buildPptx(slides);
    const output = await pptx.write({ outputType: "nodebuffer" });
    return Buffer.from(output);
  } finally {
    await browser?.close();
  }
}
var NAVIGATION_SETTLE_MS = 300;
var POST_RASTERIZE_SETTLE_MS = 100;
async function rasterizeSlideTargets(page, jobs) {
  if (jobs.length === 0) return;
  for (const { slideIdx, targets, setup, teardown } of jobs) {
    await page.evaluate((n) => {
      window.location.hash = "#" + n;
    }, slideIdx + 1);
    await new Promise((r) => setTimeout(r, NAVIGATION_SETTLE_MS));
    let slideOriginX = 0;
    let slideOriginY = 0;
    if (targets.some((t) => t.slideRelative)) {
      const origin = await page.evaluate((n) => {
        const target = document.getElementById(String(n));
        if (target) {
          const fo = target.parentElement;
          const svg = fo?.tagName.toLowerCase() === "foreignobject" ? fo.parentElement : null;
          const ref = svg?.hasAttribute("data-marpit-svg") ? svg : target;
          const r = ref.getBoundingClientRect();
          return {
            x: r.left + window.scrollX,
            y: r.top + window.scrollY
          };
        }
        const visibleSections = Array.from(
          document.querySelectorAll("section")
        ).map((section) => {
          const rect = section.getBoundingClientRect();
          const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
          const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
          const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
          return { rect, visibleArea };
        }).filter((entry) => entry.visibleArea > 0);
        if (visibleSections.length === 0) {
          console.warn(
            `[rasterize] slide ${n}: section id not found and no visible sections in viewport; using origin (0,0) which may produce an incorrect clip for bespoke.js HTML layouts.`
          );
          return { x: 0, y: 0 };
        }
        visibleSections.sort((left, right) => right.visibleArea - left.visibleArea);
        return {
          x: visibleSections[0].rect.left + window.scrollX,
          y: visibleSections[0].rect.top + window.scrollY
        };
      }, slideIdx + 1);
      slideOriginX = origin.x;
      slideOriginY = origin.y;
    }
    try {
      if (setup) await setup(page, slideIdx);
      for (const { clip, slideRelative, onCapture } of targets) {
        const effectiveClip = slideRelative ? {
          x: Math.round(slideOriginX + clip.x),
          y: Math.round(slideOriginY + clip.y),
          width: clip.width,
          height: clip.height
        } : clip;
        if (effectiveClip.width <= 0 || effectiveClip.height <= 0) continue;
        try {
          const raw = await page.screenshot({
            type: "png",
            clip: effectiveClip
          });
          onCapture(
            "data:image/png;base64," + Buffer.from(raw).toString("base64")
          );
        } catch {
        }
      }
    } finally {
      if (teardown) await teardown(page, slideIdx);
    }
  }
  await page.evaluate(() => {
    window.location.hash = "#1";
  });
  await new Promise((r) => setTimeout(r, POST_RASTERIZE_SETTLE_MS));
}
var ADVANCED_LAYERS_SELECTOR = 'section[data-marpit-advanced-background="content"], section[data-marpit-advanced-background="pseudo"]';
async function hideAdvancedLayers(page) {
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach(
      (el) => el.style.setProperty(
        "visibility",
        "hidden",
        "important"
      )
    );
  }, ADVANCED_LAYERS_SELECTOR);
}
async function restoreAdvancedLayers(page) {
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => el.style.removeProperty("visibility"));
  }, ADVANCED_LAYERS_SELECTOR);
}
async function hideSectionChildren(page, slideIdx) {
  const found = await page.evaluate((id) => {
    const section = document.getElementById(id);
    if (!section) return false;
    Array.from(section.children).forEach(
      (el) => el.style.setProperty("visibility", "hidden", "important")
    );
    return true;
  }, String(slideIdx + 1));
  if (!found) {
    console.warn(
      `[rasterize] hideSectionChildren: section id="${slideIdx + 1}" not found; children not hidden \u2014 background screenshot may include slide content.`
    );
  }
}
async function restoreSectionChildren(page, slideIdx) {
  await page.evaluate((id) => {
    const section = document.getElementById(id);
    if (!section) return;
    Array.from(section.children).forEach(
      (el) => el.style.removeProperty("visibility")
    );
  }, String(slideIdx + 1));
}
function isLocalImagePath(url) {
  if (!url) return false;
  if (url.startsWith("data:")) return false;
  if (url.startsWith("http://") || url.startsWith("https://")) return false;
  return true;
}
async function fileUrlToDataUrl(url) {
  const filePath = url.startsWith("file:") ? (0, import_node_url2.fileURLToPath)(url) : url;
  const buf = await (0, import_promises.readFile)(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : ext === "svg" ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
async function resolveImageUrls(slides) {
  const jobs = [];
  function resolveEl(el) {
    if (el.type === "image" && isLocalImagePath(el.src)) {
      jobs.push(
        fileUrlToDataUrl(el.src).then((d) => {
          el.src = d;
        })
      );
    }
    if ("children" in el && Array.isArray(el.children)) {
      for (const child of el.children) resolveEl(child);
    }
  }
  for (const slide of slides) {
    for (const bg of slide.backgroundImages ?? []) {
      if (isLocalImagePath(bg.url)) {
        jobs.push(
          fileUrlToDataUrl(bg.url).then((d) => {
            bg.url = d;
          })
        );
      }
    }
    for (const el of slide.elements ?? []) resolveEl(el);
  }
  await Promise.all(jobs);
}
async function findMissingLocalUrls(slides) {
  const urlsToCheck = /* @__PURE__ */ new Set();
  function collectImageUrls(elements) {
    for (const el of elements) {
      if (el.type === "image" && isLocalImagePath(el.src))
        urlsToCheck.add(el.src);
      if ("children" in el && Array.isArray(el.children)) {
        collectImageUrls(el.children);
      }
    }
  }
  for (const slide of slides) {
    for (const bg of slide.backgroundImages ?? []) {
      if (isLocalImagePath(bg.url)) urlsToCheck.add(bg.url);
    }
    collectImageUrls(slide.elements ?? []);
  }
  const missing = /* @__PURE__ */ new Set();
  await Promise.all(
    [...urlsToCheck].map(async (url) => {
      try {
        const filePath = url.startsWith("file:") ? (0, import_node_url2.fileURLToPath)(url) : url;
        await (0, import_promises.access)(filePath);
      } catch {
        missing.add(url);
      }
    })
  );
  return missing;
}
function buildBrokenContentImageJobs(slides, missingUrls) {
  function collectBrokenImages(elements) {
    const result = [];
    for (const el of elements) {
      if (el.type === "image" && missingUrls.has(el.src)) result.push(el);
      if ("children" in el && Array.isArray(el.children)) {
        result.push(...collectBrokenImages(el.children));
      }
    }
    return result;
  }
  return slides.flatMap((s, i) => {
    const imgs = collectBrokenImages(s.elements ?? []);
    if (imgs.length === 0) return [];
    return [
      {
        slideIdx: i,
        targets: imgs.map(
          (img) => ({
            clip: {
              x: Math.round(img.x),
              y: Math.round(img.y),
              width: Math.round(img.width),
              height: Math.round(img.height)
            },
            slideRelative: true,
            onCapture(dataUrl) {
              img.src = dataUrl;
            }
          })
        )
      }
    ];
  });
}
function pruneMissingBackgrounds(slides, missingUrls) {
  for (const slide of slides) {
    slide.backgroundImages = (slide.backgroundImages ?? []).filter(
      (bg) => !missingUrls.has(bg.url)
    );
  }
}
function buildFilteredBgJobs(slides) {
  return slides.flatMap((s, i) => {
    const bgs = (s.backgroundImages ?? []).filter((b) => b.cssFilter);
    if (bgs.length === 0) return [];
    return [
      {
        slideIdx: i,
        targets: bgs.map(
          (bg) => ({
            clip: {
              x: Math.round(bg.x),
              y: Math.round(bg.y),
              width: Math.round(bg.width),
              height: Math.round(bg.height)
            },
            slideRelative: true,
            onCapture(dataUrl) {
              bg.url = dataUrl;
              delete bg.cssFilter;
            }
          })
        ),
        setup: (p) => hideAdvancedLayers(p),
        teardown: (p) => restoreAdvancedLayers(p)
      }
    ];
  });
}
function buildCssFallbackBgJobs(slides) {
  return slides.flatMap((s, i) => {
    const bgs = (s.backgroundImages ?? []).filter((b) => b.fromCssFallback);
    if (bgs.length === 0) return [];
    return [
      {
        slideIdx: i,
        targets: bgs.map(
          (bg) => ({
            clip: {
              x: 0,
              y: 0,
              width: Math.round(s.width),
              height: Math.round(s.height)
            },
            slideRelative: true,
            onCapture(dataUrl) {
              bg.url = dataUrl;
            }
          })
        ),
        setup: (p, idx) => hideSectionChildren(p, idx),
        teardown: (p, idx) => restoreSectionChildren(p, idx)
      }
    ];
  });
}
function collectFilteredContentImages(elements) {
  const result = [];
  for (const el of elements ?? []) {
    if (el.type === "image" && el.cssFilter) result.push(el);
    if ("children" in el && Array.isArray(el.children)) {
      result.push(...collectFilteredContentImages(el.children));
    }
  }
  return result;
}
function buildFilteredContentImageJobs(slides) {
  return slides.flatMap((s, i) => {
    const imgs = collectFilteredContentImages(s.elements);
    if (imgs.length === 0) return [];
    return [
      {
        slideIdx: i,
        targets: imgs.map(
          (img) => ({
            clip: {
              x: Math.round(img.x),
              y: Math.round(img.y),
              width: Math.round(img.width),
              height: Math.round(img.height)
            },
            slideRelative: true,
            onCapture(dataUrl) {
              img.src = dataUrl;
              delete img.cssFilter;
            }
          })
        )
      }
    ];
  });
}
function collectRasterizeImages(elements) {
  const result = [];
  for (const el of elements ?? []) {
    if (el.type === "image" && el.rasterize) result.push(el);
    if ("children" in el && Array.isArray(el.children)) {
      result.push(...collectRasterizeImages(el.children));
    }
  }
  return result;
}
function buildRasterizeImageJobs(slides) {
  return slides.flatMap((s, i) => {
    const imgs = collectRasterizeImages(s.elements);
    if (imgs.length === 0) return [];
    return [
      {
        slideIdx: i,
        targets: imgs.map(
          (img) => ({
            clip: {
              x: Math.round(img.x),
              y: Math.round(img.y),
              width: Math.round(img.width),
              height: Math.round(img.height)
            },
            slideRelative: true,
            onCapture(dataUrl) {
              img.src = dataUrl;
              delete img.rasterize;
            }
          })
        )
      }
    ];
  });
}
function buildPartialBgJobs(slides) {
  return slides.flatMap((s, i) => {
    const bgs = (s.backgroundImages ?? []).filter((b) => {
      if (b.cssFilter || b.fromCssFallback) return false;
      if (b.url.startsWith("data:")) return false;
      if (b.backgroundSizeContain) return true;
      const isFullSlide = b.x <= 1 && b.y <= 1 && Math.abs(b.width - s.width) <= 2 && Math.abs(b.height - s.height) <= 2;
      return !isFullSlide;
    });
    if (bgs.length === 0) return [];
    return [
      {
        slideIdx: i,
        targets: bgs.map(
          (bg) => ({
            clip: {
              x: Math.round(bg.x),
              y: Math.round(bg.y),
              width: Math.round(bg.width),
              height: Math.round(bg.height)
            },
            slideRelative: true,
            onCapture(dataUrl) {
              bg.url = dataUrl;
            }
          })
        ),
        setup: (p) => hideAdvancedLayers(p),
        teardown: (p) => restoreAdvancedLayers(p)
      }
    ];
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  generateNativePptx
});
