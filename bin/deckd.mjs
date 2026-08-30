#!/usr/bin/env node
// npm's package `bin` entry: runs src/cli.ts straight from source, with no build
// step, via tsx's programmatic API (tsImport) -- so a plain `deckd` (via `npm
// link`, `npx deckd` inside this repo, or a global install) works out of the box.
// `node:module`'s register("tsx/esm", ...) is the more commonly documented route,
// but fails on current Node ("tsx must be loaded with --import instead of
// --loader") because register() still goes through the deprecated loader-worker
// path underneath; tsImport is tsx's own supported alternative for exactly this
// "run one file programmatically" case. See README.md for the full CLI invocation
// story, including the tsc-built dist/cli.js alternative.
import { tsImport } from "tsx/esm/api";

await tsImport("../src/cli.ts", import.meta.url);
