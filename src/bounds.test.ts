import { describe, expect, it } from "bun:test";
import {
  type BoundAction,
  type BoundInput,
  buildWrapUpPrompt,
  DEFAULT_STALL_MINUTES,
  evaluateBound,
  formatElapsed,
  MIN_WARN_REMAINING_MS,
  WARN_FRACTION,
  warnAtMs,
} from "./bounds.ts";

const MINUTE = 60_000;

function input(overrides: Partial<BoundInput> = {}): BoundInput {
  return {
    stalledForMs: 0,
    timeoutMinutes: 10,
    turnElapsedMs: 0,
    warned: false,
    ...overrides,
  };
}

describe("warnAtMs", () => {
  it("is 85% of the bound", () => {
    expect(warnAtMs(10)).toBe(510_000);
    expect(warnAtMs(60)).toBe(3_060_000);
  });

  it("tracks WARN_FRACTION rather than a hardcoded number", () => {
    expect(warnAtMs(20)).toBe(Math.floor(20 * MINUTE * WARN_FRACTION));
  });
});

describe("evaluateBound — the hard bound", () => {
  // Asserted at the exact millisecond: an off-by-one here is the difference between a bound
  // that fires and one that never does.
  const cases: Array<{ name: string; turnElapsedMs: number; action: BoundAction }> = [
    { action: "continue", name: "one ms under the bound does not kill", turnElapsedMs: 10 * MINUTE - 1 },
    { action: "kill", name: "exactly at the bound kills", turnElapsedMs: 10 * MINUTE },
    { action: "kill", name: "past the bound kills", turnElapsedMs: 11 * MINUTE },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const decision = evaluateBound(input({ turnElapsedMs: testCase.turnElapsedMs, warned: true }));
      expect(decision.action).toBe(testCase.action);
    });
  }

  it("kills exactly at the bound and not one ms before", () => {
    expect(evaluateBound(input({ turnElapsedMs: 10 * MINUTE - 1, warned: true })).action).toBe("continue");
    expect(evaluateBound(input({ turnElapsedMs: 10 * MINUTE, warned: true })).action).toBe("kill");
  });

  it("reports wall_clock as the reason with a readable elapsed", () => {
    const decision = evaluateBound(input({ turnElapsedMs: 12 * MINUTE, warned: true }));

    expect(decision.reason).toBe("wall_clock");
    expect(decision.message).toContain("bound of 10m reached after 12m");
    expect(decision.message).toContain("codex-agent report");
  });

  // Once the bound has passed there is nothing left to wrap up into, and warning would hand the
  // run more time than the caller allowed.
  it("kills rather than warns when the bound has already passed and no warn happened", () => {
    const decision = evaluateBound(input({ turnElapsedMs: 10 * MINUTE, warned: false }));

    expect(decision.action).toBe("kill");
    expect(decision.reason).toBe("wall_clock");
  });
});

describe("evaluateBound — the warn phase", () => {
  it("continues before the warn point", () => {
    expect(evaluateBound(input({ turnElapsedMs: warnAtMs(10) - 1 })).action).toBe("continue");
  });

  it("warns exactly at the warn point", () => {
    const decision = evaluateBound(input({ turnElapsedMs: warnAtMs(10) }));

    expect(decision.action).toBe("warn");
    expect(decision.reason).toBe(null);
    expect(decision.message).toContain("left of a 10m bound");
  });

  it("warns at most once per logical turn", () => {
    expect(evaluateBound(input({ turnElapsedMs: warnAtMs(10) + 1000, warned: true })).action).toBe("continue");
  });

  // A warn only pays for itself if the agent has time to actually conclude inside what remains.
  it("does not warn when too little time remains for a conclusion", () => {
    // A 1-minute bound warns at 51s, leaving 9s — under the floor.
    expect(evaluateBound(input({ timeoutMinutes: 1, turnElapsedMs: warnAtMs(1) })).action).toBe("continue");
  });

  it("does warn when the remaining time is exactly at the floor", () => {
    const timeoutMinutes = 10;
    const elapsed = timeoutMinutes * MINUTE - MIN_WARN_REMAINING_MS;

    expect(evaluateBound(input({ timeoutMinutes, turnElapsedMs: elapsed })).action).toBe("warn");
  });

  it("does not warn one ms past the floor", () => {
    const timeoutMinutes = 10;
    const elapsed = timeoutMinutes * MINUTE - MIN_WARN_REMAINING_MS + 1;

    expect(evaluateBound(input({ timeoutMinutes, turnElapsedMs: elapsed })).action).toBe("continue");
  });

  // The warn must not extend the deadline. A turn warned at 8m30s of a 10m bound is still dead
  // at 10m, not at 18m30s.
  it("still kills at the original bound after a warn", () => {
    const warned = evaluateBound(input({ turnElapsedMs: warnAtMs(10) }));
    expect(warned.action).toBe("warn");

    const later = evaluateBound(input({ turnElapsedMs: 10 * MINUTE, warned: true }));
    expect(later.action).toBe("kill");
    expect(later.reason).toBe("wall_clock");
  });
});

describe("evaluateBound — the stall backstop", () => {
  it("continues while progress is recent", () => {
    expect(evaluateBound(input({ stalledForMs: 9 * MINUTE })).action).toBe("continue");
  });

  it("kills exactly at the stall window", () => {
    const decision = evaluateBound(input({ stalledForMs: DEFAULT_STALL_MINUTES * MINUTE }));

    expect(decision.action).toBe("kill");
    expect(decision.reason).toBe("stalled");
    expect(decision.message).toContain("events, tokens and turns all flat");
  });

  it("honours an overridden stall window", () => {
    expect(evaluateBound(input({ stalledForMs: 3 * MINUTE, stallMinutes: 2 })).action).toBe("kill");
    expect(evaluateBound(input({ stalledForMs: 3 * MINUTE, stallMinutes: 5 })).action).toBe("continue");
  });

  // A stall is a hang, which is a worse diagnosis than "ran out of time" — but the wall clock
  // is the caller's explicit instruction, so it is reported first when both are true.
  it("reports the wall clock when a run is both over its bound and stalled", () => {
    const decision = evaluateBound(input({ stalledForMs: 11 * MINUTE, turnElapsedMs: 11 * MINUTE, warned: true }));
    expect(decision.reason).toBe("wall_clock");
  });

  it("kills a stalled run even before the warn point", () => {
    const decision = evaluateBound(input({ stalledForMs: 20 * MINUTE, turnElapsedMs: 1 * MINUTE }));

    expect(decision.action).toBe("kill");
    expect(decision.reason).toBe("stalled");
  });
});

describe("buildWrapUpPrompt", () => {
  it("states the remaining time concretely", () => {
    expect(buildWrapUpPrompt(90_000, false)).toContain("You have 1m left");
  });

  it("demands the verdict line for a pass that requires one", () => {
    const prompt = buildWrapUpPrompt(60_000, true);

    expect(prompt).toContain("VERDICT: BROKEN");
    expect(prompt).toContain("VERDICT: CLEAN");
  });

  it("omits the verdict instruction for a pass that does not require one", () => {
    expect(buildWrapUpPrompt(60_000, false)).not.toContain("VERDICT:");
  });

  it("forbids starting new work in both shapes", () => {
    for (const requiresVerdict of [true, false]) {
      expect(buildWrapUpPrompt(60_000, requiresVerdict)).toContain("Do not start any new investigation");
    }
  });
});

describe("formatElapsed", () => {
  it("renders seconds under a minute", () => {
    expect(formatElapsed(21_000)).toBe("21s");
    expect(formatElapsed(0)).toBe("0s");
  });

  it("renders whole minutes", () => {
    expect(formatElapsed(10 * MINUTE)).toBe("10m");
  });

  // The one-minute boundary, pinned exactly. contract.ts carried a verbatim second copy of
  // this function that spelled the same constant `60000` where this one spells `60_000`; the
  // duplicate is gone and both callers share this implementation, so the seam is here.
  it("switches from seconds to minutes exactly at one minute", () => {
    expect(formatElapsed(MINUTE - 1)).toBe("59s");
    expect(formatElapsed(MINUTE)).toBe("1m");
  });

  it("renders hours and zero-padded minutes", () => {
    expect(formatElapsed(110 * MINUTE)).toBe("1h50m");
    expect(formatElapsed(65 * MINUTE)).toBe("1h05m");
  });
});
