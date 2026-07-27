import { describe, expect, test } from "bun:test";
import { buildCodexArgs } from "./tmux.ts";

describe("codex launch args", () => {
  test("read-only sandbox is launched truthfully without bypass", () => {
    const args = buildCodexArgs({
      model: "gpt-5.5",
      reasoningEffort: "low",
      sandbox: "read-only",
      notifyHook: "/tmp/notify-hook.ts",
      jobId: "job-readonly",
    });

    expect(args).toContain("--sandbox 'read-only'");
    expect(args).toContain("--ask-for-approval 'never'");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("workspace-write sandbox is launched truthfully without bypass", () => {
    const args = buildCodexArgs({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      notifyHook: "/tmp/notify-hook.ts",
      jobId: "job-write",
    });

    expect(args).toContain("--sandbox 'workspace-write'");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("rejects malicious model text before building a shell command", () => {
    expect(() =>
      buildCodexArgs({
        model: `gpt-5.5"; touch /tmp/codex-agent-pwn #`,
        reasoningEffort: "low",
        sandbox: "workspace-write",
        notifyHook: "/tmp/notify-hook.ts",
        jobId: "job-pwn",
      }),
    ).toThrow(/Invalid Codex model name/);
  });
});
