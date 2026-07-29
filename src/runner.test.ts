import { describe, expect, it } from "bun:test";
import {
  buildCodexArgv,
  type CodexInvocation,
  isResumeArgv,
  readSandboxFromArgv,
  validateModelName,
  validateThreadId,
} from "./runner.ts";

const THREAD_ID = "019fab9e-bd54-7a70-bd34-89a2d476da92";

function invocation(overrides: Partial<CodexInvocation> = {}): CodexInvocation {
  return {
    lastMessagePath: "/tmp/jobs/abc123.last.txt",
    model: "gpt-5.6-sol",
    prompt: "Attack ONE property.",
    reasoningEffort: "xhigh",
    sandbox: "read-only",
    ...overrides,
  };
}

describe("buildCodexArgv — first turn", () => {
  it("builds the full exec command", () => {
    expect(buildCodexArgv(invocation())).toEqual([
      "exec",
      "--json",
      "-c",
      'model="gpt-5.6-sol"',
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      "skip_update_check=true",
      "-o",
      "/tmp/jobs/abc123.last.txt",
      "Attack ONE property.",
    ]);
  });

  it("puts the prompt last so it is unambiguously the positional argument", () => {
    const argv = buildCodexArgv(invocation({ prompt: "the prompt" }));
    expect(argv[argv.length - 1]).toBe("the prompt");
  });

  it("adds --skip-git-repo-check only when asked", () => {
    expect(buildCodexArgv(invocation())).not.toContain("--skip-git-repo-check");
    expect(buildCodexArgv(invocation({ skipGitRepoCheck: true }))).toContain("--skip-git-repo-check");
  });
});

describe("buildCodexArgv — resume", () => {
  it("builds the resume command with the thread id positioned third", () => {
    const argv = buildCodexArgv(invocation({ threadId: THREAD_ID }));

    expect(argv.slice(0, 3)).toEqual(["exec", "resume", THREAD_ID]);
    expect(argv[argv.length - 1]).toBe("Attack ONE property.");
  });

  it("is recognised as a resume", () => {
    expect(isResumeArgv(buildCodexArgv(invocation({ threadId: THREAD_ID })))).toBe(true);
    expect(isResumeArgv(buildCodexArgv(invocation()))).toBe(false);
  });
});

// The sharpest edge in the transport. `codex exec resume` REJECTS `--sandbox` outright
// ("error: unexpected argument '--sandbox' found"), so the tempting fix is to drop the flag
// on resume — which would let a steered or warned turn of a read-only review pass run under
// whatever ~/.codex/config.toml happens to say. These tests exist to make that regression
// impossible to land quietly.
describe("the sandbox survives on BOTH invocation shapes", () => {
  it("never emits the --sandbox flag, which resume rejects", () => {
    expect(buildCodexArgv(invocation())).not.toContain("--sandbox");
    expect(buildCodexArgv(invocation({ threadId: THREAD_ID }))).not.toContain("--sandbox");
  });

  it("carries sandbox_mode on a first turn", () => {
    expect(readSandboxFromArgv(buildCodexArgv(invocation()))).toBe("read-only");
  });

  it("carries sandbox_mode on a resumed turn", () => {
    expect(readSandboxFromArgv(buildCodexArgv(invocation({ threadId: THREAD_ID })))).toBe("read-only");
  });

  it("carries a non-default sandbox through resume unchanged", () => {
    const argv = buildCodexArgv(invocation({ sandbox: "workspace-write", threadId: THREAD_ID }));
    expect(readSandboxFromArgv(argv)).toBe("workspace-write");
  });

  it("produces byte-identical config args for a first turn and a resume", () => {
    const configOf = (argv: string[]): string[] =>
      argv.filter((_, index) => argv[index] === "-c" || argv[index - 1] === "-c");

    expect(configOf(buildCodexArgv(invocation({ threadId: THREAD_ID })))).toEqual(
      configOf(buildCodexArgv(invocation())),
    );
  });

  it("never emits -C or --cd, which resume also rejects", () => {
    for (const argv of [buildCodexArgv(invocation()), buildCodexArgv(invocation({ threadId: THREAD_ID }))]) {
      expect(argv).not.toContain("-C");
      expect(argv).not.toContain("--cd");
    }
  });
});

describe("readSandboxFromArgv", () => {
  it("returns null when no sandbox_mode is present", () => {
    expect(readSandboxFromArgv(["exec", "--json", "-c", 'model="x"'])).toBe(null);
  });

  it("returns null for an empty argv", () => {
    expect(readSandboxFromArgv([])).toBe(null);
  });

  it("does not read past the end when -c is the final element", () => {
    expect(readSandboxFromArgv(["exec", "-c"])).toBe(null);
  });

  it("ignores a sandbox_mode-looking value that is not preceded by -c", () => {
    expect(readSandboxFromArgv(["exec", 'sandbox_mode="danger-full-access"'])).toBe(null);
  });
});

describe("validateModelName", () => {
  it("accepts the model this tool pins", () => {
    expect(validateModelName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("accepts dots, colons and slashes", () => {
    expect(validateModelName("openai/gpt-5.6:latest")).toBe("openai/gpt-5.6:latest");
  });

  it("rejects a name containing a quote, which would break the -c key=value form", () => {
    expect(() => validateModelName('gpt"; rm -rf /')).toThrow("Invalid Codex model name");
  });

  it("rejects an empty name", () => {
    expect(() => validateModelName("")).toThrow("Invalid Codex model name");
  });

  it("rejects a name with a space", () => {
    expect(() => validateModelName("gpt 5")).toThrow("Invalid Codex model name");
  });

  it("rejects a name that does not start alphanumeric", () => {
    expect(() => validateModelName("-gpt-5")).toThrow("Invalid Codex model name");
  });
});

describe("validateThreadId", () => {
  it("accepts a real Codex thread id", () => {
    expect(validateThreadId(THREAD_ID)).toBe(THREAD_ID);
  });

  it("rejects a non-uuid string", () => {
    expect(() => validateThreadId("../../etc/passwd")).toThrow("Invalid Codex thread id");
  });

  it("rejects an empty id", () => {
    expect(() => validateThreadId("")).toThrow("Invalid Codex thread id");
  });

  it("refuses to build a resume argv from a bad thread id", () => {
    expect(() => buildCodexArgv(invocation({ threadId: "not a uuid" }))).toThrow("Invalid Codex thread id");
  });
});
