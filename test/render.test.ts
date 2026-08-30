import { describe, it, expect, vi } from "vitest";
import { RenderQueue, createRenderRunner, type RenderJob } from "../src/render.js";
import type { HostRenderer } from "../src/host-render.js";

function job(overrides: Partial<RenderJob> = {}): RenderJob {
  return { key: "s1:a", slug: "a", deckDir: "/tmp/does-not-matter", pptx: false, ...overrides };
}

function deferredRun() {
  const pending: Array<{ resolve: (v: { code: number; output: string }) => void; job: RenderJob }> = [];
  const run = vi.fn(
    (j: RenderJob) => new Promise<{ code: number; output: string }>((resolve) => pending.push({ resolve, job: j })),
  );
  return { run, pending };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("RenderQueue", () => {
  it("serializes per session and coalesces queued renders", async () => {
    const { run, pending } = deferredRun();
    const q = new RenderQueue(run, 2);
    q.enqueue(job({ pptx: false }));
    q.enqueue(job({ pptx: true }));
    q.enqueue(job({ pptx: false }));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.status("s1:a")).toMatchObject({ rendering: true, queued: true });
    pending[0]?.resolve({ code: 0, output: "ok" });
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending[1]?.job.pptx).toBe(true); // pptx flag survived coalescing
    pending[1]?.resolve({ code: 0, output: "ok" });
    await settle();
    expect(q.status("s1:a")).toMatchObject({ rendering: false, queued: false });
    expect(q.status("s1:a").last?.ok).toBe(true);
  });
  it("caps global concurrency", async () => {
    const { run, pending } = deferredRun();
    const q = new RenderQueue(run, 1);
    q.enqueue(job({ key: "s1:a" }));
    q.enqueue(job({ key: "s2:b", slug: "b" }));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    pending[0]?.resolve({ code: 0, output: "" });
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("records failures with output", async () => {
    const { run, pending } = deferredRun();
    const q = new RenderQueue(run, 2);
    q.enqueue(job({ key: "s1:a" }));
    await settle();
    pending[0]?.resolve({ code: 1, output: "boom" });
    await settle();
    expect(q.status("s1:a").last).toMatchObject({ ok: false, code: 1 });
    expect(q.status("s1:a").last?.output).toContain("boom");
  });
  it("keys running/queued/results by a composite session:deck key so decks stay independent", async () => {
    const { run, pending } = deferredRun();
    const q = new RenderQueue(run, 2);
    const keyA = "s1:deck-a";
    const keyB = "s1:deck-b";
    q.enqueue(job({ key: keyA, slug: "deck-a" }));
    q.enqueue(job({ key: keyA, slug: "deck-a" })); // coalesces into deck-a's queued slot
    q.enqueue(job({ key: keyB, slug: "deck-b" }));
    await settle();
    expect(run).toHaveBeenCalledTimes(2); // deck-a and deck-b run concurrently, distinct keys
    expect(q.status(keyA)).toMatchObject({ rendering: true, queued: true });
    expect(q.status(keyB)).toMatchObject({ rendering: true, queued: false });
    pending[0]?.resolve({ code: 0, output: "a-done" });
    pending[1]?.resolve({ code: 0, output: "b-done" });
    await settle();
    expect(run).toHaveBeenCalledTimes(3); // deck-a's coalesced queued job was not clobbered by deck-b
    pending[2]?.resolve({ code: 0, output: "a-again" });
    await settle();
    expect(q.status(keyA)).toMatchObject({ rendering: false, queued: false });
    expect(q.status(keyB)).toMatchObject({ rendering: false, queued: false });
    expect(q.status(keyA).last?.output).toContain("a-again");
    expect(q.status(keyB).last?.output).toContain("b-done");
  });
  it("prune drops queued/result state for keys under a prefix, leaving other sessions alone", async () => {
    const { run, pending } = deferredRun();
    const q = new RenderQueue(run, 3);
    q.enqueue(job({ key: "s1:a" }));
    q.enqueue(job({ key: "s2:a" }));
    await settle();
    pending[0]?.resolve({ code: 0, output: "s1-done" });
    pending[1]?.resolve({ code: 0, output: "s2-done" });
    await settle();
    expect(q.status("s1:a").last).not.toBeNull();
    // put s1:b into both running and queued so prune's effect on each is visible
    q.enqueue(job({ key: "s1:b", slug: "b" }));
    q.enqueue(job({ key: "s1:b", slug: "b" })); // coalesces into the queued slot
    await settle();
    expect(q.status("s1:b")).toMatchObject({ rendering: true, queued: true });

    q.prune("s1:");

    expect(q.status("s1:a").last).toBeNull(); // finished result for the deleted session is gone
    expect(q.status("s1:b").queued).toBe(false); // queued rerun dropped
    expect(q.status("s1:b").rendering).toBe(true); // the render already in flight is not interrupted
    expect(q.status("s2:a").last?.output).toContain("s2-done"); // a different session is untouched

    pending[2]?.resolve({ code: 0, output: "s1b-done" });
    await settle();
    expect(run).toHaveBeenCalledTimes(3); // the pruned queued rerun never started a 4th run
  });
  it("handles run rejection and clears running state", async () => {
    const run = vi.fn().mockRejectedValue(new Error("render died"));
    const q = new RenderQueue(run, 2);
    q.enqueue(job({ key: "s1:a" }));
    await settle();
    expect(q.status("s1:a").last).toMatchObject({ ok: false, code: -1 });
    expect(q.status("s1:a").last?.output).toContain("render died");
    expect(q.status("s1:a")).toMatchObject({ rendering: false, queued: false });
    q.enqueue(job({ key: "s1:a", slug: "b" }));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

function fakeHostRenderer(impl: HostRenderer["render"]): HostRenderer {
  return { render: impl, renderPreviews: vi.fn(), checkLayout: vi.fn() };
}

describe("createRenderRunner", () => {
  it("calls the host renderer directly with the job's key/deckDir/slug/pptx", async () => {
    const hostRender = vi.fn().mockResolvedValue({ code: 0, output: "rendered" });
    const runner = createRenderRunner(fakeHostRenderer(hostRender));

    const result = await runner(job({ deckDir: "/tmp/deck", pptx: true }));

    expect(hostRender).toHaveBeenCalledWith({ key: "s1:a", deckDir: "/tmp/deck", slug: "a", pptx: true });
    expect(result).toEqual({ code: 0, output: "rendered" });
  });
});
