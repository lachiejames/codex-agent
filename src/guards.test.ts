import { describe, expect, it } from "bun:test";
import {
  DEFAULT_STALL_MINUTES,
  advanceProgress,
  evaluateGuards,
  stalledForMs,
  type GuardInput,
  type ProgressState,
} from "./guards.ts";

const MINUTE = 60_000;

/**
 * A mid-flight run that nothing should act on. Each case overrides only what it is
 * about, so a default drifting does not silently make a case vacuous.
 */
function running(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    jobId: "test1234",
    passKind: "review",
    elapsedMs: 30_000,
    timeoutMinutes: 10,
    stalledForMs: 0,
    verdict: null,
    requiresVerdict: true,
    idleAfterTurn: false,
    blockingPrompt: null,
    reapWhenAnswered: true,
    ...overrides,
  };
}

describe("evaluateGuards — wall clock", () => {
  // The bound is inclusive. Asserted at the exact millisecond because an off-by-one here
  // is the difference between a bound that fires and one that never does.
  const cases: Array<{ name: string; elapsedMs: number; timeoutMinutes: number | null; action: string }> = [
    { name: "one ms under the bound continues", elapsedMs: 45 * MINUTE - 1, timeoutMinutes: 45, action: "continue" },
    { name: "exactly at the bound kills", elapsedMs: 45 * MINUTE, timeoutMinutes: 45, action: "kill" },
    { name: "past the bound kills", elapsedMs: 46 * MINUTE, timeoutMinutes: 45, action: "kill" },
    { name: "an unbounded run is never wall-clock killed", elapsedMs: 10 * 60 * MINUTE, timeoutMinutes: null, action: "continue" },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const decision = evaluateGuards(
        running({ elapsedMs: testCase.elapsedMs, timeoutMinutes: testCase.timeoutMinutes })
      );
      expect(decision.action).toBe(testCase.action);
      if (testCase.action === "kill") {
        expect(decision.reason).toBe("wall_clock");
        expect(decision.message).toContain("wall-clock bound");
        // A breach must always hand the caller a way to read what it did produce.
        expect(decision.message).toContain("codex-agent report test1234");
      }
    });
  }
});

describe("evaluateGuards — runaway backstop", () => {
  const stallMs = DEFAULT_STALL_MINUTES * MINUTE;

  it("one ms under the stall window continues", () => {
    expect(evaluateGuards(running({ stalledForMs: stallMs - 1 })).action).toBe("continue");
  });

  it("exactly at the stall window kills, naming the flat signals", () => {
    const decision = evaluateGuards(running({ stalledForMs: stallMs }));
    expect(decision.action).toBe("kill");
    expect(decision.reason).toBe("stalled");
    expect(decision.message).toContain("log, tokens and turns");
  });

  it("honours an explicit stall window", () => {
    expect(evaluateGuards(running({ stalledForMs: 3 * MINUTE, stallMinutes: 2 })).action).toBe("kill");
    expect(evaluateGuards(running({ stalledForMs: 3 * MINUTE, stallMinutes: 5 })).action).toBe("continue");
  });
});

describe("evaluateGuards — blocked on a human", () => {
  it("stops a blocked run immediately rather than waiting out the stall window", () => {
    const decision = evaluateGuards(
      running({
        elapsedMs: 20_000,
        blockingPrompt: { kind: "onboarding", hint: "Add trust_level to ~/.codex/config.toml" },
      })
    );
    expect(decision.action).toBe("kill");
    expect(decision.reason).toBe("blocked");
    expect(decision.message).toContain("BLOCKED");
    expect(decision.message).toContain("onboarding");
    expect(decision.message).toContain("trust_level");
  });

  it("reports blocked ahead of a wall-clock breach, because it is the actionable one", () => {
    // A run that sat on a trust prompt until its bound expired must not be reported as
    // "no verdict in 45m" — that sends you narrowing a question that was never the problem.
    const decision = evaluateGuards(
      running({
        elapsedMs: 99 * MINUTE,
        blockingPrompt: { kind: "auth", hint: null },
      })
    );
    expect(decision.reason).toBe("blocked");
  });

  it("still reaps an answered run over a stale blocking match", () => {
    const decision = evaluateGuards(
      running({ verdict: "CLEAN", blockingPrompt: { kind: "permission", hint: null } })
    );
    expect(decision.action).toBe("reap");
  });

  it("tolerates a missing hint", () => {
    const decision = evaluateGuards(running({ blockingPrompt: { kind: "auth", hint: null } }));
    expect(decision.action).toBe("kill");
    expect(decision.message).not.toContain("null");
  });
});

describe("evaluateGuards — reaping an answered run", () => {
  it("reaps a verdict pass once the verdict lands", () => {
    const decision = evaluateGuards(running({ verdict: "CLEAN" }));
    expect(decision.action).toBe("reap");
    expect(decision.message).toContain("CLEAN");
  });

  it("does not reap a verdict pass that went idle without a verdict", () => {
    // A reply with no VERDICT line is a failed run, not a concluded one. Leaving it
    // running is what preserves the exit-4 signal; the stall backstop stops it.
    expect(evaluateGuards(running({ verdict: null, idleAfterTurn: true })).action).toBe("continue");
  });

  it("reaps a plan pass on turn completion, since a plan needs no verdict", () => {
    const decision = evaluateGuards(
      running({ passKind: "plan", requiresVerdict: false, idleAfterTurn: true, timeoutMinutes: 45 })
    );
    expect(decision.action).toBe("reap");
    expect(decision.message).toContain("turn complete");
  });

  it("leaves a background run open — it may be a conversation to continue", () => {
    const decision = evaluateGuards(
      running({
        passKind: "plan",
        requiresVerdict: false,
        idleAfterTurn: true,
        reapWhenAnswered: false,
        timeoutMinutes: 45,
      })
    );
    expect(decision.action).toBe("continue");
  });

  it("reaps rather than kills a run that answered and then passed its bound", () => {
    // Scoring a concluded run as a breach would corrupt the very ledger this exists to
    // make trustworthy.
    const decision = evaluateGuards(running({ verdict: "BROKEN", elapsedMs: 99 * MINUTE }));
    expect(decision.action).toBe("reap");
    expect(decision.reason).toBeNull();
  });

  it("closes an answered background run past its bound WITHOUT recording a breach", () => {
    // Regression on an adversarial finding: the earlier version stamped
    // `killed:wall_clock` on a background job that had already reached VERDICT: CLEAN,
    // corrupting the exact signal the ledger exists to report.
    const decision = evaluateGuards(
      running({
        verdict: "CLEAN",
        reapWhenAnswered: false,
        elapsedMs: 61_000,
        timeoutMinutes: 1,
      })
    );
    expect(decision.action).toBe("reap");
    expect(decision.reason).toBeNull();
  });

  it("closes an answered background plan past its bound the same way", () => {
    const decision = evaluateGuards(
      running({
        passKind: "plan",
        requiresVerdict: false,
        idleAfterTurn: true,
        reapWhenAnswered: false,
        elapsedMs: 46 * MINUTE,
        timeoutMinutes: 45,
      })
    );
    expect(decision.action).toBe("reap");
  });

  it("still bounds a background run that never answers", () => {
    // The whole point of lifting the guards out of the --wait path.
    const decision = evaluateGuards(
      running({ reapWhenAnswered: false, elapsedMs: 45 * MINUTE, timeoutMinutes: 45 })
    );
    expect(decision.action).toBe("kill");
    expect(decision.reason).toBe("wall_clock");
  });
});

describe("INVARIANT: an answered run is never recorded as a breach", () => {
  // Three separate adversarial passes found three separate ways through this. It is not a
  // property of one branch, so it is asserted exhaustively rather than case by case: for
  // EVERY combination of bound state, stall state, blocking state and reap flag, an
  // answered run must come back with reason === null.
  const flags = [false, true];

  for (const requiresVerdict of flags) {
    for (const pastBound of flags) {
      for (const stalled of flags) {
        for (const blocked of flags) {
          for (const reapWhenAnswered of flags) {
            const label =
              `requiresVerdict=${requiresVerdict} pastBound=${pastBound} ` +
              `stalled=${stalled} blocked=${blocked} reap=${reapWhenAnswered}`;

            it(`never breaches: ${label}`, () => {
              const decision = evaluateGuards(
                running({
                  requiresVerdict,
                  // Answered, in whichever way this pass profile counts as answered.
                  verdict: requiresVerdict ? "CLEAN" : null,
                  idleAfterTurn: true,
                  timeoutMinutes: 45,
                  elapsedMs: pastBound ? 46 * MINUTE : MINUTE,
                  stalledForMs: stalled ? DEFAULT_STALL_MINUTES * MINUTE : 0,
                  blockingPrompt: blocked ? { kind: "permission", hint: null } : null,
                  reapWhenAnswered,
                })
              );

              expect(decision.reason).toBeNull();
              expect(decision.action).not.toBe("kill");
              // And it is closed exactly when it should be, never left holding a session
              // past a bound.
              const shouldClose = reapWhenAnswered || pastBound || stalled;
              expect(decision.action).toBe(shouldClose ? "reap" : "continue");
            });
          }
        }
      }
    }
  }

  it("does not extend the invariant to an unanswered run", () => {
    // The guard must still bite when there is nothing to protect.
    const decision = evaluateGuards(
      running({
        requiresVerdict: true,
        verdict: null,
        idleAfterTurn: false,
        elapsedMs: 46 * MINUTE,
        timeoutMinutes: 45,
      })
    );
    expect(decision.action).toBe("kill");
    expect(decision.reason).toBe("wall_clock");
  });
});

describe("evaluateGuards — no false positives on measured healthy runs", () => {
  // These are the runs the tool exists to serve. Every one of them must survive, or the
  // guards have made the tool useless in the name of protecting it.

  it("does not touch the golden 51s review, which makes ZERO exec calls by design", () => {
    // Job a8106fca: 52s, 33k tokens, execCount 0, verdict BROKEN — correct. The prompt
    // tells it "Do not read other files", so zero execs is health, not spinning. A
    // zero-exec fail-fast would have killed this run, which is why `evaluateGuards`
    // takes no exec count at all.
    const decision = evaluateGuards(
      running({ passKind: "review", elapsedMs: 51_000, timeoutMinutes: 10, stalledForMs: 2_000 })
    );
    expect(decision.action).toBe("continue");
  });

  it("does not touch the 25m/13.7M-token plan run judged excellent", () => {
    // Job 1e2a3578: 25m, 83 execs, 13,684,096 tokens. No token ceiling exists here, so
    // spend cannot stop it — only a flat-lined or over-time run can.
    const decision = evaluateGuards(
      running({
        passKind: "plan",
        requiresVerdict: false,
        elapsedMs: 25 * MINUTE,
        timeoutMinutes: 45,
        stalledForMs: 20_000,
      })
    );
    expect(decision.action).toBe("continue");
  });

  it("does not touch the 18m/2.8M plan run mid-flight", () => {
    // Job f343761d, the run the handover called a catastrophe. It produced a substantive
    // plan and cost 5x less than the run above; nothing here stops it either.
    const decision = evaluateGuards(
      running({
        passKind: "plan",
        requiresVerdict: false,
        elapsedMs: 18 * MINUTE,
        timeoutMinutes: 45,
        stalledForMs: 45_000,
      })
    );
    expect(decision.action).toBe("continue");
  });
});

describe("advanceProgress", () => {
  const base: ProgressState = {
    lastProgressAtMs: 1_000,
    logBytes: 500, logMtimeMs: 0, logIdentity: "1:1",
    tokensSpent: 100,
    turnsCompleted: 0,
  };

  it("seeds state from the first sample", () => {
    const state = advanceProgress(null, {
      observedAtMs: 7_000,
      logBytes: 10, logMtimeMs: 0, logIdentity: "1:1",
      tokensSpent: null,
      turnsCompleted: 0,
    });
    expect(state.lastProgressAtMs).toBe(7_000);
    expect(state.logBytes).toBe(10);
  });

  const growthCases: Array<{ name: string; logBytes: number; tokensSpent: number | null; turnsCompleted: number }> = [
    { name: "log growth is progress", logBytes: 501, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 100, turnsCompleted: 0 },
    { name: "token growth is progress", logBytes: 500, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 101, turnsCompleted: 0 },
    { name: "a completed turn is progress", logBytes: 500, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 100, turnsCompleted: 1 },
  ];

  for (const testCase of growthCases) {
    it(testCase.name, () => {
      const state = advanceProgress(base, {
        observedAtMs: 9_000,
        logBytes: testCase.logBytes, logMtimeMs: 0, logIdentity: "1:1",
        tokensSpent: testCase.tokensSpent,
        turnsCompleted: testCase.turnsCompleted,
      });
      expect(state.lastProgressAtMs).toBe(9_000);
    });
  }

  it("treats every signal flat as no progress", () => {
    const state = advanceProgress(base, {
      observedAtMs: 9_000,
      logBytes: 500, logMtimeMs: 0, logIdentity: "1:1",
      tokensSpent: 100,
      turnsCompleted: 0,
    });
    expect(state.lastProgressAtMs).toBe(1_000);
    expect(stalledForMs(state, 9_000)).toBe(8_000);
  });

  it("counts a log regrowing after truncation as progress", () => {
    // Regression on a defect an adversarial pass found in the first implementation. With a
    // high-water mark, a truncated log had to climb back past its old size before any
    // output counted — so a working run could be killed for writing while below the mark.
    // Only a live writer can grow a file, so this must reset the clock.
    const shrunk = advanceProgress(base, {
      observedAtMs: 2_000,
      logBytes: 100, logMtimeMs: 0, logIdentity: "1:1",
      tokensSpent: 100,
      turnsCompleted: 0,
    });
    // The shrink counts too. It cannot be told apart from a truncation the run is writing
    // through, and erring toward "still working" is the only safe direction here.
    expect(shrunk.lastProgressAtMs).toBe(2_000);

    const recovered = advanceProgress(shrunk, {
      observedAtMs: 3_000,
      logBytes: 400, logMtimeMs: 0, logIdentity: "1:1",
      tokensSpent: 100,
      turnsCompleted: 0,
    });
    expect(recovered.lastProgressAtMs).toBe(3_000);
  });

  it("does not kill a working run whose truncated log is still below its old size", () => {
    // The end-to-end form of the same defect, at the decision boundary.
    let state = advanceProgress(null, {
      observedAtMs: 0,
      logBytes: 1_000, logMtimeMs: 0, logIdentity: "1:1",
      tokensSpent: 100,
      turnsCompleted: 0,
    });
    // Truncated, then writing steadily — but never back above 1,000 bytes.
    for (const [at, bytes] of [
      [10_000, 400],
      [30_000, 600],
      [60_000, 900],
    ] as const) {
      state = advanceProgress(state, {
        observedAtMs: at,
        logBytes: bytes, logMtimeMs: 0, logIdentity: "1:1",
        tokensSpent: 100,
        turnsCompleted: 0,
      });
    }

    const decision = evaluateGuards(
      running({ stalledForMs: stalledForMs(state, 60_000), stallMinutes: 1 })
    );
    expect(decision.action).toBe("continue");
  });

  it("credits a single observation that spans a truncation and partial regrowth", () => {
    // A second adversarial finding: with observations minutes apart, a log truncated and
    // regrown to LESS than its previous reading is indistinguishable from regression. The
    // run was appending the whole time, so the clock must reset — any change counts.
    const state = advanceProgress(
      { lastProgressAtMs: 0, logBytes: 1_000, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 50, turnsCompleted: 0 },
      { observedAtMs: 600_000, logBytes: 600, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 50, turnsCompleted: 0 }
    );
    expect(state.lastProgressAtMs).toBe(600_000);
    expect(
      evaluateGuards(running({ stalledForMs: stalledForMs(state, 600_000), stallMinutes: 10 })).action
    ).toBe("continue");
  });

  it("credits output when a truncation regrows to exactly the same size", () => {
    // A fourth adversarial finding: file size alone aliases. Truncate and write exactly as
    // many bytes back and the sampled size is identical, so a run producing output
    // continuously read as flat. A live writer always moves mtime.
    const state = advanceProgress(
      { lastProgressAtMs: 0, logBytes: 100, logMtimeMs: 1_000, logIdentity: "1:1", tokensSpent: null, turnsCompleted: 0 },
      { observedAtMs: 60_000, logBytes: 100, logMtimeMs: 59_000, logIdentity: "1:1", tokensSpent: null, turnsCompleted: 0 }
    );
    expect(state.lastProgressAtMs).toBe(60_000);
    expect(
      evaluateGuards(running({ stalledForMs: stalledForMs(state, 60_000), stallMinutes: 1 })).action
    ).toBe("continue");
  });

  it("does not accumulate stall time from a log that was replaced under it", () => {
    // A sixth adversarial finding: rename the live log and plant an unchanging decoy at the
    // original path. Existence alone is satisfied — *a* file resolves — but it is not the
    // file Codex is writing, so nothing it says about staleness is about this run.
    const state = advanceProgress(
      { lastProgressAtMs: 0, logBytes: 100, logMtimeMs: 1_000, logIdentity: "1:100", tokensSpent: null, turnsCompleted: 0 },
      { observedAtMs: 60_000, logBytes: 100, logMtimeMs: 1_000, logIdentity: "1:999", tokensSpent: null, turnsCompleted: 0 }
    );
    expect(state.lastProgressAtMs).toBe(60_000);
  });

  it("does not accumulate stall time when the log does not resolve at all", () => {
    const state = advanceProgress(
      { lastProgressAtMs: 0, logBytes: 100, logMtimeMs: 1_000, logIdentity: "1:100", tokensSpent: null, turnsCompleted: 0 },
      { observedAtMs: 60_000, logBytes: 0, logMtimeMs: 0, logIdentity: null, tokensSpent: null, turnsCompleted: 0 }
    );
    // Absent evidence is not evidence of a hang, however long it persists.
    expect(stalledForMs(state, 10 * DEFAULT_STALL_MINUTES * MINUTE)).toBe(0);
  });

  it("still stops a genuinely flat log, which is what a hang looks like", () => {
    // The backstop must survive the loosening above: a hung session's log does not change
    // at all, so it is still caught.
    const state = advanceProgress(
      { lastProgressAtMs: 0, logBytes: 1_000, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 50, turnsCompleted: 0 },
      { observedAtMs: 600_000, logBytes: 1_000, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 50, turnsCompleted: 0 }
    );
    expect(state.lastProgressAtMs).toBe(0);
    expect(
      evaluateGuards(running({ stalledForMs: stalledForMs(state, 600_000), stallMinutes: 10 })).action
    ).toBe("kill");
  });

  it("counts a first-ever token reading as progress", () => {
    const state = advanceProgress(
      { lastProgressAtMs: 1_000, logBytes: 500, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: null, turnsCompleted: 0 },
      { observedAtMs: 4_000, logBytes: 500, logMtimeMs: 0, logIdentity: "1:1", tokensSpent: 12, turnsCompleted: 0 }
    );
    expect(state.lastProgressAtMs).toBe(4_000);
  });

  it("keeps the last known token count when a reading goes missing", () => {
    const state = advanceProgress(base, {
      observedAtMs: 4_000,
      logBytes: 500, logMtimeMs: 0, logIdentity: "1:1",
      tokensSpent: null,
      turnsCompleted: 0,
    });
    expect(state.tokensSpent).toBe(100);
    expect(state.lastProgressAtMs).toBe(1_000);
  });
});

describe("stalledForMs", () => {
  it("never reports negative time", () => {
    const state: ProgressState = {
      lastProgressAtMs: 5_000,
      logBytes: 0, logMtimeMs: 0, logIdentity: "1:1",
      tokensSpent: null,
      turnsCompleted: 0,
    };
    expect(stalledForMs(state, 1_000)).toBe(0);
  });
});
