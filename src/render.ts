import type { HostRenderer } from "./host-render.js";

export interface RenderResult { ok: boolean; code: number; output: string; finishedAt: number; durationMs: number }

export interface RenderJob {
  key: string;
  slug: string;
  deckDir: string;
  pptx: boolean;
}

export type RenderFn = (job: RenderJob) => Promise<{ code: number; output: string }>;

// Keyed by whatever the caller passes (server.ts uses `${deckId}:${deck}`),
// so renders for different slugs under the same deck id never coalesce or block
// each other; the running-count cap below is still global across all keys.
export class RenderQueue {
  private running = new Set<string>();
  // One queued job per key (Map-keyed coalescing); pump re-checks the cap each iteration.
  private queued = new Map<string, RenderJob>();
  private results = new Map<string, RenderResult>();
  onSettle?: (key: string) => void;

  constructor(private run: RenderFn, private maxConcurrent = 2) {}

  enqueue(job: RenderJob): void {
    const existing = this.queued.get(job.key);
    if (this.running.has(job.key) || existing !== undefined) {
      this.queued.set(job.key, { ...job, pptx: job.pptx || (existing?.pptx ?? false) });
      return;
    }
    this.queued.set(job.key, job);
    this.pump();
  }

  status(key: string): { rendering: boolean; queued: boolean; last: RenderResult | null } {
    return {
      rendering: this.running.has(key),
      queued: this.queued.has(key),
      last: this.results.get(key) ?? null,
    };
  }

  // Drops queued and result state for every key starting with keyPrefix (e.g. every
  // slug of a deleted deck, keyed `${deckId}:`). A render already in flight for
  // one of those keys keeps running to completion; record() just writes a result
  // nothing will ever read again.
  prune(keyPrefix: string): void {
    for (const key of this.queued.keys()) if (key.startsWith(keyPrefix)) this.queued.delete(key);
    for (const key of this.results.keys()) if (key.startsWith(keyPrefix)) this.results.delete(key);
  }

  private pump(): void {
    for (const [key, job] of this.queued) {
      if (this.running.size >= this.maxConcurrent) return;
      if (this.running.has(key)) continue;
      this.queued.delete(key);
      this.runJob(job);
    }
  }

  private runJob(job: RenderJob): void {
    this.running.add(job.key);
    const started = Date.now();
    void this.run(job)
      .then((r) => this.record(job.key, r.code === 0, r.code, r.output, started))
      .catch((e: unknown) => this.record(job.key, false, -1, String(e), started));
  }

  private record(key: string, ok: boolean, code: number, output: string, started: number): void {
    this.results.set(key, { ok, code, output: output.slice(-8000), finishedAt: Date.now(), durationMs: Date.now() - started });
    this.running.delete(key);
    this.onSettle?.(key);
    this.pump();
  }
}

// Every render is now a direct host render: there is no sandbox to run a deck's
// charts.py in, so a deck's chart images (if any) must already be committed --
// charts execution is deliberately not something this renderer does.
export function createRenderRunner(hostRenderer: HostRenderer): RenderFn {
  return (job) => hostRenderer.render({ key: job.key, deckDir: job.deckDir, slug: job.slug, pptx: job.pptx });
}
