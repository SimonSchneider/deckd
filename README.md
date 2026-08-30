# deckd

A self-contained deck-building service: a Marp markdown editor + renderer with an
[MCP](https://modelcontextprotocol.io/) server, so any AI client can edit decks
directly using its own subscription ("bring your own AI"). deckd has no runtime
dependency on any particular AI provider or external repo -- your organization's
theme/assets/examples ship as an uploadable **bundle**.

## Run deckd

```bash
git clone https://github.com/SimonSchneider/deckd.git
cd deckd
npm install
DECKD_BUNDLE_DIR=examples/starter-bundle npm run dev
# open http://127.0.0.1:8790
```

`examples/starter-bundle` is a minimal bundle (theme + one example deck) so the
above works with nothing else set up. For real use, build your own bundle (see
[Rendering and the bundle](#rendering-and-the-bundle) below) and point
`DECKD_BUNDLE_DIR` at it, or upload it once deckd is running.

Every data dir defaults under `DECKD_DATA_DIR` (default `./data`), so a bare
`npm run dev` works out of the box. Useful overrides:

| Env var                      | Default                          | What it is                                   |
| ----------------------------- | --------------------------------- | --------------------------------------------- |
| `DECKD_PORT`                  | `8790`                            | HTTP port                                     |
| `DECKD_DATA_DIR`               | `./data`                          | Anchor for every dir below                    |
| `DECKD_DB`                     | `<data>/deckd.sqlite3`             | Sqlite session store                          |
| `DECKD_DEV_USER`               | `dev@localhost`                   | Local trial has no auth; every request acts as this user |
| `DECKD_BUNDLE_DIR`             | `<data>/bundle`                   | Active bundle (see below)                     |
| `DECKD_SCRATCH_DIR`            | `<data>/render-scratch`           | Host-render working dir                       |
| `DECKD_CANONICAL_CACHE_DIR`    | `<data>/canonical-cache`          | Cache for rendering example decks             |
| `DECKD_LOCAL_SESSIONS_DIR`     | `<data>/local-sessions`           | Every session's deck directory                |
| `DECKD_CHROME_PATH` / `CHROME_PATH` | macOS default Chrome install | Chrome binary for slide-layout checks         |

## Test

```bash
npm test
npm run typecheck
```

## Smoke Test

Verify end-to-end flow against the real running service:

```bash
scripts/smoke.sh
```

Requires deckd running (`npm run dev`).

## Architecture

deckd is three pieces over one engine core:

- **Web app** (`src/server.ts`, `public/index.html`): a session list, a markdown
  editor, and a PDF/PPTX preview. No in-app AI -- editing is either by hand in
  the browser or by an external AI over MCP.
- **MCP server** (`src/mcp.ts`), mounted at `/mcp`: the same session/render/asset
  operations as the web app, exposed as tools for an external AI client.
- **Render engine** (`src/host-render.ts`, `src/render.ts`): renders a deck to
  PDF/PPTX, slide previews, and a layout check, running marp-cli directly against
  the active bundle's theme. Every render is a direct host render; there is no
  sandbox and no chart execution (a client that generates charts uploads the
  resulting images itself, via `upload_asset`/`/api/sessions/:id/assets`).
- **CLI** (`src/cli.ts`, `bin/deckd.mjs`): the same render engine as a standalone
  command, so an advanced user can run deckd inside their own repo as a marp
  wrapper with no server involved. See [CLI](#cli) below.

A session is a plain directory: `<DECKD_LOCAL_SESSIONS_DIR>/<sessionId>/presentations/<slug>/`.
There is no other backing store.

## Rendering and the bundle

Renders run on the host, against the active **bundle** — a directory + manifest
(`deckd.json`) carrying a prebuilt theme and, optionally, shared assets, example
decks, and an authoring guide. See `examples/starter-bundle/` for the minimal
shape.

Update the bundle by zipping one (`deckd pack`, see [CLI](#cli)) and uploading it
at `/admin.html`, or directly:

```bash
curl -X PUT --data-binary @bundle.zip http://127.0.0.1:8790/api/bundle
curl http://127.0.0.1:8790/api/bundle   # current manifest, file/example counts, upload time
curl -o deckd-bundle.zip http://127.0.0.1:8790/api/bundle/download   # download the current bundle
```

`/admin.html` also has a "Download current bundle" link for the same route.

The upload is validated (manifest well-formed and resolves, every file's extension
on a content allowlist -- css/md/json/svg/png/jpg/jpeg/webp/gif/woff/woff2/ttf/otf/txt,
no symlinks, per-file and total size caps) and swapped in atomically, live, with no
restart -- every session picks up the new bundle on its very next render. For local
dev without a zip in hand, point `DECKD_BUNDLE_DIR` at a bundle directory you
already have (e.g. `examples/starter-bundle`), or build one with `deckd pack`.

If a bundle upload is interrupted between its two renames, the old bundle is left
at `<bundleDir>.stale-<uuid>` instead of being cleaned up; recover by renaming it
back to `<bundleDir>`.

To re-render every session's own deck after a bundle change (e.g. a theme fix),
use `scripts/rerender-all.sh` — it lists sessions via `/api/me` and POSTs a render
for each:

```bash
scripts/rerender-all.sh
```

Requires deckd running.

### Render options

`deckd.json` may carry an optional `render` block to tune marp invocations:

```json
{ "theme": "theme.css", "render": { "imageScale": 2, "pdfOutlines": false, "pdfNotes": false } }
```

- `imageScale` (0.5-4, default 2): resolution multiplier for `get_slide_previews`'
  PNGs. Previews only -- humans read the vector PDF, which this never touches.
- `pdfOutlines` / `pdfNotes` (booleans, default false): add bookmarks / presenter
  notes as annotations to the rendered PDF.

Unknown keys inside `render` are rejected, not ignored -- a typo'd key errors
loudly on load rather than silently doing nothing.

## CLI

`deckd` also runs as a standalone CLI: the same engine code as the server, with no
HTTP, sessions, or MCP involved -- for an advanced user running deckd inside their
own repo as a marp wrapper.

### Invoking it

No build step is required. From a plain checkout (`npm install` at the repo root,
which installs `tsx`, a devDependency the CLI needs -- acceptable for now):

```bash
npm exec deckd -- <command> [args]          # runs bin/deckd.mjs
# or, without going through npm:
node bin/deckd.mjs <command> [args]
# or, from any directory, once linked or installed globally:
npm link   # (in this repo) then `deckd <command> [args]` anywhere
```

`bin/deckd.mjs` (the package's `bin` entry) runs `src/cli.ts` straight from source
via tsx's programmatic API (`tsx/esm/api`'s `tsImport`) -- this is what makes it
work regardless of the caller's own `cwd` or `node_modules` (unlike
`node --import tsx src/cli.ts`, which resolves the `tsx` specifier relative to
the *caller's* cwd and fails outside this repo).

A built entry point also works, after `npm run build`:

```bash
node dist/cli.js <command> [args]
```

### Commands

`render`, `check`, and `previews` run against the **bundle rooted at the current
directory** — it must contain `deckd.json` at its root (a clear error names the
missing file otherwise). `<deck-dir>` may be a relative path like
`presentations/my-deck`; its directory name is the deck's slug and must be a valid
one (lowercase letters/digits/hyphens, matching the same rule as everywhere else in
deckd).

| Command | What it does |
| --- | --- |
| `deckd render <deck-dir> [--pptx]` | Renders to PDF (and, with `--pptx`, an editable PPTX) next to the deck's `slides.md` -- `render.sh` parity. `--pptx` needs Chrome; a plain render does not. |
| `deckd check <deck-dir>` | Runs the slide-layout overflow check and prints a human-readable report; exits 1 if any slide has an issue. Needs Chrome. |
| `deckd previews <deck-dir>` | Renders one PNG per slide into `<deck-dir>/preview/`. |
| `deckd pack [-o bundle.zip] [--theme P] [--assets P] [--examples P] [--guide P]` | Zips `deckd.json` plus only its manifest-referenced paths, for uploading via `/api/bundle`. Inside a repo that already has `deckd.json`, the flags are ignored -- its own manifest is used verbatim. In a repo **without** one, the flags synthesize a manifest (`--theme` is then required); it's written into the zip only, never into the repo. Never touches Chrome or marp. |
| `deckd serve` | Starts the same web/MCP server as `npm run dev`. |

A Chrome or marp-cli resolution failure (`check`, or `render --pptx`, on a machine
without Chrome; any render command if `@marp-team/marp-cli` isn't installed) is
reported clearly and specifically to the command that needed it -- `pack` never
attempts either.

## MCP (BYOAI)

deckd exposes an MCP server at `http://127.0.0.1:8790/mcp` so an external AI
client (Claude Desktop, claude.ai, the `claude` CLI) can edit decks directly,
using its own subscription.

**Trust note:** this is a local trial only. There is no authentication —
every MCP tool call acts as `DECKD_DEV_USER` — which is safe only because
deckd binds `127.0.0.1` and is never exposed beyond your machine.

### Claude Desktop

Settings → Connectors → Add custom connector, with URL
`http://127.0.0.1:8790/mcp`.

### claude CLI

```bash
claude mcp add --transport http deckd http://127.0.0.1:8790/mcp
```

### Tools

| Tool                 | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------- |
| `read_guide`         | Returns the active bundle's authoring guide. Call this first.             |
| `list_sessions`      | Lists your sessions (id, slug, timestamps).                              |
| `create_session`     | Creates a session, optionally seeded with markdown.                      |
| `list_examples`      | Lists canonical example decks for style reference.                       |
| `get_deck`           | Reads a deck's markdown, mtime, and asset listing (own session or example). |
| `write_slides`       | Saves markdown and renders; returns render errors to iterate on.         |
| `upload_asset`       | Saves an image/SVG under `images/` or `charts/`, returns its path.       |
| `get_slide_previews` | Renders and returns slide screenshots as images, to check your work.     |
| `check_deck`         | Checks for slide-layout overflow before calling a deck done.             |
| `export_deck`        | Returns the download URL for a deck's zip export.                        |

### Admin MCP

deckd also exposes a **separate** MCP endpoint at `http://127.0.0.1:8790/mcp-admin`
for managing the live bundle. This is deliberately not on `/mcp`: a deck-editing AI
client only ever gets the 10 tools above, never bundle-management tools.

**Trust note:** `/mcp-admin` has no authentication at all -- anyone who can reach it
can rewrite the live bundle immediately, with no restart. Only bind deckd to
`127.0.0.1` (the default) and never expose this endpoint beyond your machine. Phase 1
gates it behind auth.

```bash
claude mcp add --transport http deckd-admin http://127.0.0.1:8790/mcp-admin
```

| Tool                 | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------- |
| `get_bundle_info`    | Reads the manifest and a recursive file listing (path, size, mtime).     |
| `read_bundle_file`   | Reads one bundle file: UTF-8 text, or base64 for binary (5MB cap).       |
| `write_bundle_file`  | Writes one file (partial update -- no need to re-send the whole bundle). |
| `delete_bundle_file` | Deletes one file; rejected if the manifest still refers to it.          |
| `upload_bundle`      | Full bundle replace from a zip, same validation as `PUT /api/bundle`.    |
| `download_bundle`    | Returns the `/api/bundle/download` URL.                                  |

`write_bundle_file`/`delete_bundle_file` validate the whole resulting bundle (content
allowlist, size caps, manifest still resolves) before applying a change; a change that
would break the bundle is rejected and the live bundle is left completely unchanged --
the same stage-validate-swap `installBundleZip` uses for a full upload.

## Security model

Deck HTML and any `<script>` a deck's markdown embeds (marp `--html`) execute
in the rendering/measuring Chrome with network access — the same exposure
marp's own rendering path has always had; deckd adds nothing beyond it.
`checkLayout`'s per-run nonce in the marker id defends against blind forgery
of the metrics marker; a deck script that actively harvests the marker id at
runtime can still forge results — acceptable under the trusted-internal-use
model above. It also guards only against unbounded Chrome output; it adds no
sandbox around Chrome itself. This is acceptable for trusted internal use.
Revisit before hosting decks from untrusted authors (Phase 1).

The pptx export path (`render({pptx: true})`) launches a second, separate Chrome
through the vendored `gen-pptx.js`/`native-pptx.cjs` (see
`vendor/marp-to-editable-pptx/README.md`), with the same posture as the Chrome
above: no `--no-sandbox`, and killed on timeout the same way (see that vendor
README's "local deviations" note for how the timeout kill reaches this second
Chrome despite it launching detached into its own process group).
