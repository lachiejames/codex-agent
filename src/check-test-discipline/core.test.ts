import { describe, expect, it } from "bun:test";
import { formatViolations, hasInlineWaiver, isTestFile, scanTestFile, type Violation } from "./core.ts";

// Every fixture below is assembled by concatenation so this file does not match its OWN rules.
// A checker whose test fixtures trip the checker is a checker nobody can run.
const DOT = ".";
const ONLY = `${DOT}on` + "ly(";
const SKIP = `${DOT}sk` + "ip(";
const SKIP_IF = "skip" + "If(";
const TODO = `${DOT}to` + "do(";
const TRUTHY = `${DOT}toBeTru` + "thy()";
const DEFINED = `${DOT}toBeDef` + "ined()";
const MOCK = "sp" + "yOn(";

function scan(content: string, relativePath = "src/example.test.ts"): Violation[] {
  return scanTestFile({ content, relativePath });
}

function ruleIds(violations: readonly Violation[]): string[] {
  return violations.map((violation) => violation.ruleId);
}

describe("isTestFile", () => {
  it("recognises this repo's co-located convention", () => {
    expect(isTestFile("src/bounds.test.ts")).toBe(true);
    expect(isTestFile("src/check-test-discipline/core.test.ts")).toBe(true);
  });

  it("ignores source files", () => {
    expect(isTestFile("src/bounds.ts")).toBe(false);
    expect(isTestFile("src/test-helpers.ts")).toBe(false);
  });

  it("ignores a file merely containing the word test", () => {
    expect(isTestFile("src/testing.ts")).toBe(false);
  });
});

describe("scanTestFile — disabled tests", () => {
  it("catches a focused test", () => {
    const violations = scan(`it${ONLY}"x", () => {});`);
    expect(ruleIds(violations)).toEqual(["no-focused-tests"]);
  });

  it("catches a focused describe", () => {
    expect(ruleIds(scan(`describe${ONLY}"x", () => {});`))).toEqual(["no-focused-tests"]);
  });

  it("catches a skipped test", () => {
    expect(ruleIds(scan(`test${SKIP}"x", () => {});`))).toEqual(["no-skipped-tests"]);
  });

  it("catches the xit form", () => {
    const xitCall = "x" + 'it("x", () => {});';
    expect(ruleIds(scan(xitCall))).toEqual(["no-skipped-tests"]);
  });

  // The exact form that shipped in PR #1 and had to be reverted.
  it("catches skipIf, the form that actually got through", () => {
    expect(ruleIds(scan(`test.${SKIP_IF}process.platform === "darwin")("x", () => {});`))).toEqual([
      "no-conditional-skips",
    ]);
  });

  it("catches a bare platform branch inside a test file", () => {
    const branch = "if (process.plat" + 'form === "linux") { return; }';
    expect(ruleIds(scan(branch))).toEqual(["no-conditional-skips"]);
  });

  it("catches a placeholder test", () => {
    expect(ruleIds(scan(`it${TODO}"later");`))).toEqual(["no-placeholder-tests"]);
  });

  it("tolerates whitespace around the dot", () => {
    const spaced = "it . on" + "ly (";
    expect(ruleIds(scan(`${spaced}"x", () => {});`))).toEqual(["no-focused-tests"]);
  });
});

describe("scanTestFile — weak assertions", () => {
  it("catches a truthiness assertion", () => {
    expect(ruleIds(scan(`expect(x)${TRUTHY};`))).toEqual(["no-truthiness-assertions"]);
  });

  it("catches an existence-only assertion", () => {
    expect(ruleIds(scan(`expect(x)${DEFINED};`))).toEqual(["no-existence-only-assertions"]);
  });

  it("catches toHaveProperty with no value", () => {
    const bare = "toHaveProp" + 'erty("id")';
    expect(ruleIds(scan(`expect(x).${bare};`))).toEqual(["no-property-existence-assertions"]);
  });

  // Asserting a key is ABSENT is complete — there is no value to assert about something that is
  // not there. This repo pins that the ledger's old merged `totalTokens` field stayed gone.
  it("allows the negative form, which asserts absence", () => {
    const negative = "not.toHaveProp" + 'erty("totalTokens")';
    expect(scan(`expect(row).${negative};`)).toEqual([]);
  });

  it("allows toHaveProperty WITH a value", () => {
    const valued = "toHaveProp" + 'erty("id", "abc-123")';
    expect(scan(`expect(x).${valued};`)).toEqual([]);
  });

  it("catches a typeof assertion", () => {
    const typeofCall = "expect(type" + "of x)";
    expect(ruleIds(scan(`${typeofCall}.toBe("string");`))).toEqual(["no-typeof-assertions"]);
  });
});

describe("scanTestFile — mocks", () => {
  it("catches spyOn", () => {
    expect(ruleIds(scan(`const s = ${MOCK}globalThis, "fetch");`))).toEqual(["no-mocks"]);
  });

  it("catches a vitest mock factory", () => {
    const factory = "vi." + "fn()";
    expect(ruleIds(scan(`const f = ${factory};`))).toEqual(["no-mocks"]);
  });
});

describe("scanTestFile — the inline waiver", () => {
  it("suppresses a weak assertion when waived on the same line", () => {
    expect(scan(`expect(x)${DEFINED}; // weak-ok: the id is generated at runtime`)).toEqual([]);
  });

  // The waiver reaches weak assertions ONLY. A disabled test and a mock have no legitimate
  // exception, and a waiver that reached them would be the thing this checker prevents.
  it("does NOT suppress a disabled test", () => {
    expect(ruleIds(scan(`it${ONLY}"x", () => {}); // weak-ok: just debugging`))).toEqual(["no-focused-tests"]);
  });

  it("does NOT suppress a mock", () => {
    expect(ruleIds(scan(`${MOCK}obj, "m"); // weak-ok: only for this test`))).toEqual(["no-mocks"]);
  });

  it("does not apply to a waiver on a different line", () => {
    const content = ["// weak-ok: this is not the right line", `expect(x)${DEFINED};`].join("\n");
    expect(ruleIds(scan(content))).toEqual(["no-existence-only-assertions"]);
  });
});

describe("scanTestFile — debt comments", () => {
  it("catches a TODO marker", () => {
    expect(ruleIds(scan("// TODO: assert the error case too"))).toEqual(["no-test-debt-comments"]);
  });

  it("catches a lowercase fixme marker", () => {
    expect(ruleIds(scan("// fixme this is flaky"))).toEqual(["no-test-debt-comments"]);
  });

  it("ignores an ordinary explanatory comment", () => {
    expect(scan("// This asserts the exact boundary, because an off-by-one is the whole bug.")).toEqual([]);
  });

  it("ignores the word todo inside prose", () => {
    expect(scan("// the scheduler has a todo list, which this covers")).toEqual([]);
  });
});

describe("scanTestFile — scope and shape", () => {
  it("ignores non-test files entirely", () => {
    expect(scan(`it${ONLY}"x", () => {});`, "src/bounds.ts")).toEqual([]);
  });

  it("reports the file and the 1-indexed line", () => {
    const content = ['import { it } from "bun:test";', "", `it${ONLY}"x", () => {});`].join("\n");
    const violations = scan(content, "src/thing.test.ts");

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/thing.test.ts");
    expect(violations[0]?.line).toBe(3);
    expect(violations[0]?.text).toBe(`it${ONLY}"x", () => {});`);
  });

  it("reports every violation on a line, not just the first", () => {
    const violations = scan(`expect(x)${TRUTHY}; expect(y)${DEFINED};`);
    expect(ruleIds(violations).toSorted()).toEqual(["no-existence-only-assertions", "no-truthiness-assertions"]);
  });

  it("returns nothing for a clean file", () => {
    const content = [
      'import { describe, expect, it } from "bun:test";',
      'describe("thing", () => {',
      '  it("returns the exact value", () => {',
      "    expect(compute(2)).toBe(4);",
      "  });",
      "});",
    ].join("\n");

    expect(scan(content)).toEqual([]);
  });

  it("returns nothing for an empty file", () => {
    expect(scan("")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const violations = scan(`import x;\r\nit${ONLY}"x", () => {});\r\n`);
    expect(violations[0]?.line).toBe(2);
  });
});

describe("formatViolations", () => {
  const violation: Violation = {
    file: "src/thing.test.ts",
    line: 12,
    message: "Do not land focused tests.",
    ruleId: "no-focused-tests",
    text: `it${ONLY}...)`,
  };

  it("is empty when there is nothing to report", () => {
    expect(formatViolations([])).toBe("");
  });

  it("names the file, line, rule and remedy", () => {
    const output = formatViolations([violation]);

    expect(output).toContain("src/thing.test.ts:12");
    expect(output).toContain("[no-focused-tests]");
    expect(output).toContain("Do not land focused tests.");
  });

  it("uses the singular for one violation and the plural for more", () => {
    expect(formatViolations([violation])).toContain("1 test-discipline violation:");
    expect(formatViolations([violation, violation])).toContain("2 test-discipline violations:");
  });
});

describe("hasInlineWaiver", () => {
  it("requires the marker to carry a reason", () => {
    expect(hasInlineWaiver("expect(x).toBeDefined(); // weak-ok: generated at runtime")).toBe(true);
  });

  it("is false for an ordinary comment", () => {
    expect(hasInlineWaiver("expect(x).toBe(1); // exact")).toBe(false);
  });
});
