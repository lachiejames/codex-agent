import { describe, expect, it } from "bun:test";
import { composeGate, formatGateSummary, type GateResult, gateChecks } from "./core.ts";

describe("gateChecks", () => {
  it("runs every quality check the repo owns, in reporting order", () => {
    expect(gateChecks().map((check) => check.name)).toEqual([
      "format",
      "lint",
      "typecheck",
      "test-discipline",
      "conventions",
      "dead-code",
      "test",
      "build",
    ]);
  });

  // The whole point of this module: knip was installed, configured, red, and run by nothing.
  it("includes the dead-code check that no gate used to run", () => {
    const deadCode = gateChecks().find((check) => check.name === "dead-code");
    expect(deadCode).toEqual({ args: ["run", "knip"], cmd: "bun", name: "dead-code" });
  });

  it("delegates to package.json scripts so tool flags are defined in one place", () => {
    for (const check of gateChecks()) {
      expect(check.cmd).toBe("bun");
    }
    // Only `bun test` is not a script indirection; everything else is `bun run <script>`.
    const direct = gateChecks().filter((check) => check.args[0] !== "run");
    expect(direct).toEqual([{ args: ["test"], cmd: "bun", name: "test" }]);
  });
});

describe("composeGate", () => {
  it("passes only when every check passed", () => {
    const results: GateResult[] = [
      { name: "lint", ok: true },
      { name: "test", ok: true },
    ];
    expect(composeGate(results)).toEqual({ failed: [], ok: true });
  });

  // The no-short-circuit contract: a run with two failures must report BOTH, because the
  // predecessor `a && b && c` chain reported only the first and hid the rest.
  it("reports every failure, not just the first, in run order", () => {
    const results: GateResult[] = [
      { name: "format", ok: false },
      { name: "lint", ok: true },
      { name: "typecheck", ok: false },
    ];
    expect(composeGate(results)).toEqual({ failed: ["format", "typecheck"], ok: false });
  });

  it("treats an empty run as passing", () => {
    expect(composeGate([])).toEqual({ failed: [], ok: true });
  });
});

describe("formatGateSummary", () => {
  it("states success plainly", () => {
    expect(formatGateSummary({ failed: [], ok: true })).toBe("gate: all checks passed.");
  });

  it("names the single failure and uses the singular", () => {
    expect(formatGateSummary({ failed: ["knip"], ok: false })).toBe("gate: 1 check FAILED — knip");
  });

  it("names every failure and uses the plural", () => {
    expect(formatGateSummary({ failed: ["format", "typecheck"], ok: false })).toBe(
      "gate: 2 checks FAILED — format, typecheck",
    );
  });
});
