import { describe, expect, it } from "bun:test";
import { EXEMPT_MARKER, formatFindings, MAX_FUNCTION_LINES, type SourceInput, scanConventions } from "./core.ts";

/** A function whose BODY spans exactly `bodyLines` lines. */
function fnWithBodyLines(name: string, bodyLines: number, lead = ""): string {
  // `{` opens the body on the signature line and `}` closes it, so the body spans
  // 2 + filler lines. Working back from that keeps the fixtures honest about the boundary.
  const filler = Array.from({ length: bodyLines - 2 }, (_, i) => `  const x${i} = ${i};`).join("\n");
  return `${lead}export function ${name}(): void {\n${filler}\n}\n`;
}

function src(text: string, path = "src/probe.ts"): SourceInput {
  return { path, text };
}

describe("function-length rule", () => {
  it("passes a body of exactly the limit", () => {
    const findings = scanConventions([src(fnWithBodyLines("atLimit", MAX_FUNCTION_LINES))]);
    expect(findings).toEqual([]);
  });

  it("fails a body one line over the limit", () => {
    const findings = scanConventions([src(fnWithBodyLines("overByOne", MAX_FUNCTION_LINES + 1))]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.rule).toBe("function-length");
    expect(findings[0]?.message).toContain(`${MAX_FUNCTION_LINES + 1}-line body`);
    expect(findings[0]?.path).toBe("src/probe.ts");
  });

  it("accepts an inline exemption that carries a reason", () => {
    const lead = `// ${EXEMPT_MARKER}: one linear template, splitting it scatters the print order\n`;
    const findings = scanConventions([src(fnWithBodyLines("exempted", MAX_FUNCTION_LINES + 40, lead))]);
    expect(findings).toEqual([]);
  });

  it("accepts an exemption inside a JSDoc block above the function", () => {
    const lead = `/**\n * Does a thing.\n *\n * ${EXEMPT_MARKER}: the sequencing here is the invariant\n */\n`;
    const findings = scanConventions([src(fnWithBodyLines("jsdocExempt", MAX_FUNCTION_LINES + 5, lead))]);
    expect(findings).toEqual([]);
  });

  // The mechanism is the REASON, not the marker. A bare marker must not buy silence.
  it("rejects a bare exemption marker with no reason", () => {
    const lead = `// ${EXEMPT_MARKER}:\n`;
    const findings = scanConventions([src(fnWithBodyLines("noReason", MAX_FUNCTION_LINES + 5, lead))]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.rule).toBe("function-length");
  });

  it("names the offending function so the message is actionable", () => {
    const findings = scanConventions([src(fnWithBodyLines("theLongOne", MAX_FUNCTION_LINES + 3))]);
    expect(findings[0]?.message).toContain("theLongOne");
  });
});

describe("bare-builtin-import rule", () => {
  it("fails a bare builtin specifier", () => {
    const findings = scanConventions([src(`import { readFileSync } from "fs";\n`)]);
    expect(findings).toEqual([
      {
        line: 1,
        message: 'imports "fs" without the node: prefix. Use "node:fs".',
        path: "src/probe.ts",
        rule: "bare-builtin-import",
      },
    ]);
  });

  it("passes the node: form", () => {
    expect(scanConventions([src(`import { readFileSync } from "node:fs";\n`)])).toEqual([]);
  });

  it("ignores a local module that merely shares a builtin's name", () => {
    expect(scanConventions([src(`import { thing } from "./path.ts";\n`)])).toEqual([]);
  });

  // AST, not regex: this checker's own header contains the text `from "fs"` in a comment, and a
  // line scanner would flag its own documentation.
  it("does not flag a builtin name appearing in a comment or a string", () => {
    const text = `// this module used to import from "fs" directly\nconst note = 'from "path"';\nexport function noteIt(): string {\n  return note;\n}\n`;
    expect(scanConventions([src(text)])).toEqual([]);
  });
});

describe("duplicate-export rule", () => {
  // Modelled on the actual defect: the two `formatElapsed` copies, six statements each, identical
  // but for one writing `60_000` where the other wrote `60000`.
  const elapsed = (minuteConstant: string): string =>
    `export function formatElapsed(ms: number): string {\n` +
    `  const totalMinutes = Math.floor(ms / ${minuteConstant});\n` +
    `  const hours = Math.floor(totalMinutes / 60);\n` +
    `  const minutes = totalMinutes % 60;\n` +
    `  if (hours > 0) return \`\${hours}h\${minutes}m\`;\n` +
    `  if (totalMinutes > 0) return \`\${totalMinutes}m\`;\n` +
    `  return \`\${Math.floor(ms / 1000)}s\`;\n` +
    `}\n`;
  const bodyA = elapsed("60_000");
  const bodyB = elapsed("60000");

  it("catches one implementation living in two files despite a different numeric spelling", () => {
    const findings = scanConventions([src(bodyA, "src/bounds.ts"), src(bodyB, "src/contract.ts")]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.rule).toBe("duplicate-export");
    expect(findings[0]?.message).toContain("src/bounds.ts, src/contract.ts");
  });

  it("ignores the same implementation exported once", () => {
    expect(scanConventions([src(bodyA, "src/bounds.ts")])).toEqual([]);
  });

  // The first run of this checker flagged exactly this pair, and it was wrong to.
  it("does not flag two unrelated functions that merely share a name", () => {
    const one = `export function formatViolations(v: string[]): string {\n  const n = v.length;\n  const joined = v.join("; ");\n  return \`\${n}: \${joined}\`;\n}\n`;
    const two = `export function formatViolations(v: string[]): string {\n  const n = v.length;\n  const head = v[0] ?? "none";\n  return \`\${head} and \${n} more\`;\n}\n`;
    expect(scanConventions([src(one, "src/contract.ts"), src(two, "src/checker.ts")])).toEqual([]);
  });

  // Regression: this checker's first version flagged every pair of thin delegating wrappers,
  // because `return helper();` normalises to the same text in any two files.
  it("does not flag trivial delegating wrappers that share a one-line body", () => {
    const one = `export function a(): number {\n  return helper();\n}\n`;
    const two = `export function b(): number {\n  return helper();\n}\n`;
    expect(scanConventions([src(one, "src/one.ts"), src(two, "src/two.ts")])).toEqual([]);
  });

  it("ignores non-exported helpers that happen to match", () => {
    const helper = `function shared(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n`;
    expect(scanConventions([src(helper, "src/one.ts"), src(helper, "src/two.ts")])).toEqual([]);
  });
});

describe("formatFindings", () => {
  it("reports a clean scan with the file count, so a zero-file run is visible", () => {
    expect(formatFindings([], 20)).toBe("check-conventions: 20 files clean.");
  });

  it("uses the singular for one finding", () => {
    const findings = scanConventions([src(fnWithBodyLines("one", MAX_FUNCTION_LINES + 1))]);
    expect(formatFindings(findings, 3)).toContain("1 violation across 3 files");
  });

  it("lists every finding with its path, line and rule", () => {
    const findings = scanConventions([
      src(fnWithBodyLines("one", MAX_FUNCTION_LINES + 1), "src/a.ts"),
      src(`import { x } from "os";\n`, "src/b.ts"),
    ]);
    const report = formatFindings(findings, 2);
    expect(report).toContain("2 violations across 2 files");
    expect(report).toContain("src/a.ts:1  [function-length]");
    expect(report).toContain("src/b.ts:1  [bare-builtin-import]");
  });
});
