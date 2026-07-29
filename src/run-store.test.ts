import { describe, expect, it } from "bun:test";
import { shouldResumeThread } from "./run-store.ts";

// REGRESSION. The supervisor hardcoded `resume = false` for its first invocation, which is
// right for the first supervisor of a run and wrong for every one after it. `send` on an idle
// run spawns a FRESH supervisor, so a multi-turn conversation quietly started a second Codex
// thread: the context was gone, and the run record still reported the first thread id — so it
// claimed an answer belonged to a conversation that had not produced it.
//
// Caught live, not by a test: two turns, two answers, both persisted, everything looking
// correct, and only the recalled value revealed it.
describe("shouldResumeThread", () => {
  it("starts a new thread when the run has none", () => {
    expect(shouldResumeThread({})).toBe(false);
  });

  it("resumes once the run has a thread", () => {
    expect(shouldResumeThread({ threadId: "019fac1d-f4fc-71e2-9e0e-9285bd889985" })).toBe(true);
  });

  it("treats an empty thread id as no thread rather than as one to resume", () => {
    // `codex exec resume ""` is not a resumable conversation, so this must start fresh.
    expect(shouldResumeThread({ threadId: "" })).toBe(false);
  });
});
