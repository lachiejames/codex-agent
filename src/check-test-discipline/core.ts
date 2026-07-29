/**
 * check-test-discipline/core.ts
 *
 * Pure functions for test anti-enshitification enforcement. No filesystem I/O — every function
 * here operates on strings, so the whole ruleset is unit-testable with direct calls.
 *
 * Ported from ~/dev/personal/slopweaver's `check-no-test-enshitification`, re-skinned for
 * `bun:test` and for a single-package repo where tests are co-located with their source.
 *
 * WHY THIS EXISTS: a `test.skipIf(...)` shipped in PR #1 of this repo and had to be taken back
 * out. Nothing checked, so nothing caught it. The rules were written down and remembered rather
 * than executed, and a rule that is only remembered is a rule that holds until the first time
 * it is inconvenient.
 *
 * The effectful shell — walking the tree, reading files, printing, exiting — is index.ts.
 */

export interface PatternRule {
  id: string;
  message: string;
  pattern: RegExp;
}

export interface Violation {
  file: string;
  line: number;
  message: string;
  ruleId: string;
  text: string;
}

/**
 * A test that does not run is worse than a missing test: it reports as coverage while proving
 * nothing, and its absence is invisible in a green summary.
 *
 * `skipIf` is named explicitly. It is the form that got through, because it reads as
 * environment-awareness rather than as skipping — and the correct fix in that case was to
 * extract the platform-dependent choice into a pure function and test that on every machine.
 */
export const DISABLED_TEST_RULES: PatternRule[] = [
  {
    id: "no-focused-tests",
    message: "Do not land focused tests. Remove .only before committing — it silently skips every other test.",
    pattern: /\b(?:describe|it|test)\s*\.\s*only\s*\(/,
  },
  {
    id: "no-skipped-tests",
    message: "Do not land skipped tests. Fix the test, or delete it outright and say so.",
    pattern: /\b(?:describe|it|test)\s*\.\s*skip\s*\(|\b(?:xdescribe|xit|xtest)\s*\(/,
  },
  {
    id: "no-conditional-skips",
    message:
      "Do not gate a test on the environment. If it cannot run everywhere, extract the pure logic " +
      "and test that instead — a test that silently does nothing on CI is not a test.",
    pattern: /\bskipIf\s*\(|\btodoIf\s*\(|\bif\s*\(\s*process\.platform\s*[!=]==?\s*["']/,
  },
  {
    id: "no-placeholder-tests",
    message: "Do not land placeholder tests. An unimplemented test is a note, not a check.",
    pattern: /\b(?:it|test)\s*\.\s*(?:todo|failing)\s*\(/,
  },
];

/**
 * Assertions that pass for almost any value.
 *
 * `toBeDefined()` on a value whose exact content is knowable asserts only that the code ran.
 * These are the assertions that turn a red test green without turning a bug into a fix.
 */
export const WEAK_ASSERTION_RULES: PatternRule[] = [
  {
    id: "no-truthiness-assertions",
    message: "Assert the actual value, not its truthiness. toBe(true) / toBe(false) / toBe(null).",
    pattern: /\.\s*(?:toBeTruthy|toBeFalsy)\s*\(\s*\)/,
  },
  {
    id: "no-existence-only-assertions",
    message:
      "toBeDefined() alone asserts only that the code ran. Assert the value. Allowed with an " +
      "inline `// weak-ok:` comment on the same line when the value is genuinely non-deterministic.",
    pattern: /\.\s*toBeDefined\s*\(\s*\)/,
  },
  {
    id: "no-property-existence-assertions",
    message: "toHaveProperty(name) without a value asserts a key exists. Assert what it holds.",
    // The negative form is EXEMPT. `expect(x).not.toHaveProperty("old")` asserts a key is absent,
    // which is a complete assertion — there is no value to assert about something that is not
    // there. This repo uses it to pin that the ledger's merged `totalTokens` field stayed gone
    // after being split into two, which is exactly the kind of thing worth asserting.
    pattern: /(?<!\.not)\.\s*toHaveProperty\s*\(\s*["'][^"']+["']\s*\)/,
  },
  {
    id: "no-typeof-assertions",
    message: "expect(typeof x) asserts a shape the type system already guarantees. Assert the value.",
    pattern: /\bexpect\s*\(\s*typeof\s/,
  },
];

/**
 * Mocks.
 *
 * A unit test of a pure function needs none, and if a mock seems necessary the design is telling
 * you to extract the pure logic. This repo currently has ZERO mocks across its whole suite, which
 * is a property worth keeping rather than rediscovering.
 */
export const MOCK_RULES: PatternRule[] = [
  {
    id: "no-mocks",
    message:
      "No mocks. If isolating this needs a mock, extract the pure logic and test that — see the " +
      "core.ts / index.ts split this checker itself uses.",
    pattern: /\bmock\s*\(|\bspyOn\s*\(|\b(?:vi|jest)\s*\.\s*(?:fn|mock|spyOn)\s*\(/,
  },
];

export const DEBT_COMMENT_RULES: PatternRule[] = [
  {
    id: "no-test-debt-comments",
    message: "Do not leave TODO/FIXME/SKIP debt markers in test code. Fix it, delete it, or ask.",
    pattern: /^\s*(?:\/\/|\/\*)\s*(?:TODO|FIXME|SKIP|SKIPPED|HACK|XXX)\b/i,
  },
];

export const ALL_RULES: PatternRule[] = [
  ...DISABLED_TEST_RULES,
  ...WEAK_ASSERTION_RULES,
  ...MOCK_RULES,
  ...DEBT_COMMENT_RULES,
];

/**
 * An escape hatch that is narrow, visible and per-line.
 *
 * A file-level or repo-level disable is indistinguishable from deleting the rule; a same-line
 * marker is a decision someone has to write next to the thing it excuses, and it shows up in
 * every diff and every grep.
 */
const WEAK_OK_MARKER = "// weak-ok:";

export function hasInlineWaiver(line: string): boolean {
  return line.includes(WEAK_OK_MARKER);
}

/** Is this a test file, by this repo's co-located naming convention? */
export function isTestFile(relativePath: string): boolean {
  return relativePath.endsWith(".test.ts");
}

/**
 * Scan one test file.
 *
 * Rules apply line by line. A same-line `// weak-ok:` waiver suppresses only the weak-assertion
 * family — never a disabled test, never a mock. Those two have no legitimate exception here, and
 * an exception mechanism that reaches them would be the enshitification it exists to prevent.
 */
export function scanTestFile({ content, relativePath }: { content: string; relativePath: string }): Violation[] {
  if (!isTestFile(relativePath)) return [];

  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine ?? "";
    const waived = hasInlineWaiver(line);

    for (const rule of ALL_RULES) {
      if (!rule.pattern.test(line)) continue;
      if (waived && WEAK_ASSERTION_RULES.some((weak) => weak.id === rule.id)) continue;

      violations.push({
        file: relativePath,
        line: index + 1,
        message: rule.message,
        ruleId: rule.id,
        text: line.trim(),
      });
    }
  }

  return violations;
}

/** Human-readable report. Empty string when there is nothing to report. */
export function formatViolations(violations: readonly Violation[]): string {
  if (violations.length === 0) return "";

  const lines = [`${violations.length} test-discipline violation${violations.length === 1 ? "" : "s"}:`, ""];

  for (const violation of violations) {
    lines.push(
      `  ${violation.file}:${violation.line}  [${violation.ruleId}]`,
      `    ${violation.text}`,
      `    ${violation.message}`,
      "",
    );
  }

  return lines.join("\n");
}
