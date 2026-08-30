// A deckd-authored reference for Marp/Marpit markdown syntax, appended to read_guide's
// response so an agent gets correct syntax from deckd itself instead of from web
// lookup or model memory. Verified against the installed @marp-team/marpit and
// @marp-team/marp-core source (directives.js, image/parse.js,
// background_image/parse.js, comment.js) rather than written from recollection --
// see the deckd repo's implementation task for the exact files checked.
export const MARP_SYNTAX_REFERENCE = `## Marp syntax reference (built-in)

A deck is a single Markdown file rendered by Marp. This is deckd's own quick
reference for the syntax; it does not depend on outside lookup.

### Front-matter

The deck starts with a YAML front-matter block that turns on Marp mode and sets
deck-wide defaults:

\`\`\`markdown
---
marp: true
theme: default
paginate: true
size: 16:9
---
\`\`\`

- \`marp: true\` is required -- without it the file renders as plain Markdown, not slides.
- \`theme\` picks the theme CSS (check the bundle's guide for which themes it ships).
- \`paginate: true\` turns on page numbers for every slide (see "Directives" below).
- \`size\` picks a preset slide size the theme defines, e.g. \`16:9\` or \`4:3\`.

### Slide separator

Slides split on a line containing exactly three hyphens:

\`\`\`markdown
# First slide

---

# Second slide
\`\`\`

Don't use \`---\` for a Markdown horizontal rule inside a slide -- it always splits
the deck.

### Directives

Directives are YAML \`key: value\` lines. They can appear in the leading
front-matter block, or in an HTML comment anywhere on a slide:

\`\`\`markdown
<!-- class: lead -->
\`\`\`

There are two scopes:

- **Global** directives (\`theme\`, \`size\`, \`paginate\` as a deck-wide default, ...)
  apply to the whole deck and are normally set once, in the front-matter.
- **Local** directives (\`class\`, \`paginate\`, \`header\`, \`footer\`,
  \`backgroundColor\`) apply from the slide they're set on **onward**, to every
  following slide, not just that one.

To scope a local directive to **only the current slide**, prefix its key with an
underscore:

\`\`\`markdown
<!-- _class: lead -->
\`\`\`

\`<!-- class: lead -->\` on slide 3 makes slide 3 *and every slide after it* use the
\`lead\` class, until something changes it again. \`<!-- _class: lead -->\` affects
only slide 3.

Common local directives:

- \`class\` -- HTML class(es) on the slide's \`<section>\`, for theme-defined layout variants.
- \`paginate\` -- \`true\`/\`false\`, show or hide the page number from here on.
- \`header\` / \`footer\` -- inline Markdown injected as a header/footer on each slide.
- \`backgroundColor\` -- CSS color for the slide background.

### Images

Standard Markdown image syntax accepts size and style options after a space, inside
the alt text:

\`\`\`markdown
![w:300 h:200](images/diagram.png)
![width:300](images/diagram.png)
\`\`\`

\`w\`/\`width\` and \`h\`/\`height\` accept a bare number (treated as px), a CSS length
(\`px\`, \`em\`, \`cm\`, ...), or \`auto\`. \`%\` is not a supported unit here -- it is
accepted but produces no sizing at all (empirically verified: \`![w:50%](...)\`
renders at the image's natural size, with no styling applied).

#### Background images

Adding \`bg\` to the same option list turns an image into a full-bleed slide
background instead of an inline image:

\`\`\`markdown
![bg](images/photo.jpg)
![bg fit](images/photo.jpg)
![bg cover](images/photo.jpg)
![bg left](images/photo.jpg)
![bg right:30%](images/photo.jpg)
\`\`\`

- \`fit\` / \`contain\` letterboxes the image inside the slide; \`cover\` fills the
  slide, cropping as needed (this is the default sizing when no keyword is given).
- \`left\` / \`right\` splits the slide in half, image on that side and content on the
  other; append \`:<percent>\` (e.g. \`right:30%\`) to change the split width.
- Multiple \`![bg]\` images in a row on the same slide lay out side by side, splitting
  the background area evenly between them:

\`\`\`markdown
![bg](images/a.jpg)
![bg](images/b.jpg)
\`\`\`

#### Relative paths

Image paths resolve relative to the deck's own directory
(\`presentations/<slug>/\`), the same directory \`slides.md\` lives in -- not the
process's working directory. Use \`images/photo.png\` or \`charts/plot.svg\` for
assets uploaded with \`upload_asset\`, and \`../../assets/...\` for shared assets the
bundle ships alongside its examples.

### Presenter notes

An HTML comment that isn't a directive holds presenter notes, not deck content --
it never renders on the slide itself:

\`\`\`markdown
# A slide with notes

<!-- Mention the Q3 numbers here before moving on. -->
\`\`\`

A slide can have more than one note comment; each becomes its own paragraph in
the collected notes, in document order. Presenter notes carry through to a
rendered PPTX's speaker notes, and, when the bundle enables \`pdfNotes\` render
output, they also show as PDF annotations.

### Inline HTML

Raw HTML is enabled, but keep slides Markdown-first: reach for HTML only for
things Markdown genuinely can't express (fine-grained layout, an inline
\`<style>\` tweak), not as a default way to write content.

### deckd specifics

- \`check_deck\` / \`write_slides\`' \`layout_issues\` flag content that overflows the
  fixed slide box. Fix an overflow by splitting the slide into two, not by
  shrinking fonts below the theme's own sizes.
- \`preview/\` inside a deck directory is reserved for deckd's own rendered slide
  screenshots -- never write deck content there.
- \`write_slides\` returns both render errors (\`render_code\`/\`render_output\`) and
  structural \`layout_issues\` in the same response; keep iterating until
  \`render_code\` is 0 and \`layout_issues\` is empty.
`;
