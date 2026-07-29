// The effectful edge of `bun run validate`: spawn each check, report all of them, exit.
//
// Thin by construction — the plan and the verdict are pure and unit-tested in core.ts. This
// file owns only the spawning, the printing and the exit status.

import { spawnSync } from "node:child_process";
import { composeGate, formatGateSummary, type GateResult, gateChecks } from "./core.ts";

function runGate(): number {
  const checks = gateChecks();
  const results: GateResult[] = [];

  for (const check of checks) {
    console.log(`\n──── ${check.name} ────`);
    // Inherited stdio: each tool's own diagnostics reach the terminal unchanged. The gate adds
    // a heading and a summary; it never reformats or swallows what a tool said.
    const outcome = spawnSync(check.cmd, [...check.args], { stdio: "inherit" });
    results.push({ name: check.name, ok: outcome.status === 0 });
  }

  const verdict = composeGate(results);
  console.log(`\n${formatGateSummary(verdict)}`);
  return verdict.ok ? 0 : 1;
}

process.exit(runGate());
