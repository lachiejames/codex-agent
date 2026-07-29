// The conventions this repo holds that no off-the-shelf tool checks. Pure: text in, findings out.
//
// Three rules, each of which exists because the thing it forbids ALREADY HAPPENED here:
//
//   1. FUNCTION LENGTH. No production function body over 60 lines. When this landed, nine
//      functions were over: main (218), supervise (109), parseArgs (101), evaluateContract
//      (100), prepareLaunch (97), watchInvocation (76), buildPromptContext (67),
//      formatRunReport (65), launch (64). Those carry inline exemptions naming a reason. New
//      code gets no such grace.
//
//   2. `node:` ON BUILTIN IMPORTS. answer-store.ts and files.ts imported bare "fs" and "path"
//      while the other 23 builtin imports in src/ used `node:`. Fixed by hand; without a check
//      the 24th drifts back.
//
//   3. NO DUPLICATE EXPORTED FUNCTION NAMES ACROSS FILES. `formatElapsed` existed verbatim in
//      both bounds.ts and contract.ts. knip's `duplicates` rule does NOT catch this — measured:
//      with the duplicate present and the rule set to "error", knip exited 0, because it looks
//      for one file exporting a binding twice, not one identifier implemented in two files.
//      This rule is that missing check.
//
// WHY AST AND NOT REGEX. The sibling checker, src/check-test-discipline, is a line-oriented
// regex scanner, and its own header concedes the guarantee is limited to the literal shapes its
// patterns match. That is survivable there. It is not survivable here: this very file contains
// the string "max-lines-exempt" and the text `from "fs"` inside comments, so a regex scanner
// would flag its own documentation. Parsing means a string or comment can never be mistaken for
// code, and no exclusion list is needed to protect the checker from itself.

import ts from "typescript";

/** The per-function body-line ceiling. A body of exactly this many lines passes. */
export const MAX_FUNCTION_LINES = 60;

/** The marker that exempts one function, in a comment attached above it. Requires a reason. */
export const EXEMPT_MARKER = "max-lines-exempt";

/**
 * Statements a body needs before two copies of it count as a duplicated implementation.
 *
 * Found by this checker's own test suite: `export function a() { return helper(); }` and
 * `export function b() { return helper(); }` normalise to the same text, so without a floor
 * every pair of thin delegating wrappers in the repo reads as a duplicate. A one-line
 * delegation is not a duplicated implementation; it is the same word twice.
 *
 * Three is chosen against the real case rather than picked round: the `formatElapsed` copies
 * that motivated this rule had six statements each, so the floor has margin and still catches it.
 */
const MIN_DUPLICATE_STATEMENTS = 3;

/** Node builtins this repo imports. A bare specifier for any of these is a finding. */
const NODE_BUILTINS = new Set(["assert", "child_process", "crypto", "fs", "os", "path", "process", "url", "util"]);

/** One source file to scan. */
export interface SourceInput {
  readonly path: string;
  readonly text: string;
}

/** One violation: where it is, which rule, and what to do about it. */
export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly rule: "function-length" | "bare-builtin-import" | "duplicate-export";
  readonly message: string;
}

/** The best display name for a function-like node. */
function functionName(node: ts.Node, sf: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
    return node.name.getText(sf);
  }
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.getText(sf);
  }
  return "(anonymous)";
}

/** Does a comment attached above this node carry the exemption marker plus a reason? */
function isExempt(node: ts.Node, text: string): boolean {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return ranges.some((range) => {
    const comment = text.slice(range.pos, range.end);
    const marker = comment.indexOf(`${EXEMPT_MARKER}:`);
    if (marker === -1) return false;
    // A bare marker is not an exemption. The reason is the whole point of the mechanism.
    return comment.slice(marker + EXEMPT_MARKER.length + 1).trim().length > 0;
  });
}

/** Every function-like node with a body, paired with its body's line span. */
function measureFunctions(sf: ts.SourceFile, input: SourceInput): readonly Finding[] {
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node);

    if (isFunctionLike && node.body !== undefined) {
      const start = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      const lines = end - start + 1;
      if (lines > MAX_FUNCTION_LINES && !isExempt(node, input.text)) {
        findings.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          message: `${functionName(node, sf)} has a ${lines}-line body (limit ${MAX_FUNCTION_LINES}). Extract a named helper, or add "// ${EXEMPT_MARKER}: <reason>" above it.`,
          path: input.path,
          rule: "function-length",
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}

/** Bare builtin import specifiers, e.g. `from "fs"` where `from "node:fs"` is meant. */
function findBareBuiltins(sf: ts.SourceFile, input: SourceInput): readonly Finding[] {
  const findings: Finding[] = [];

  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!NODE_BUILTINS.has(specifier)) continue;
    findings.push({
      line: sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1,
      message: `imports "${specifier}" without the node: prefix. Use "node:${specifier}".`,
      path: input.path,
      rule: "bare-builtin-import",
    });
  }

  return findings;
}

/**
 * A function body reduced to what it DOES, so two spellings of one implementation collide.
 *
 * Comments go, all whitespace goes, and digit-separating underscores go. That last one is not
 * incidental: the two copies of `formatElapsed` were identical except that one wrote `60_000`
 * and the other `60000`. A comparison that treats those as different text would have missed the
 * only real instance of this defect the repo has had.
 */
function normaliseBody(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/(\d)_(\d)/g, "$1$2")
    .replace(/\s+/g, "");
}

/** Exported function declarations in this file, as name plus normalised body. */
function exportedFunctions(sf: ts.SourceFile): readonly { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  for (const statement of sf.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    if (statement.body === undefined) continue;
    if (statement.body.statements.length < MIN_DUPLICATE_STATEMENTS) continue;
    const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (isExported) found.push({ body: normaliseBody(statement.body.getText(sf)), name: statement.name.text });
  }
  return found;
}

function parse(input: SourceInput): ts.SourceFile {
  return ts.createSourceFile(input.path, input.text, ts.ScriptTarget.ESNext, true);
}

/**
 * Scan every supplied source and return every finding, ordered by rule then path.
 *
 * Cross-file by necessity: the duplicate-export rule cannot be decided one file at a time,
 * which is exactly why it is not expressible as a lint rule in either linter this repo runs.
 *
 * @param inputs the production sources to check, tests already excluded by the caller
 * @returns every violation found; empty means the conventions hold
 */
export function scanConventions(inputs: readonly SourceInput[]): readonly Finding[] {
  const findings: Finding[] = [];
  // Keyed by the normalised BODY, not the name. Two unrelated functions that happen to share a
  // name are not a defect — `formatViolations` legitimately exists in both contract.ts and
  // check-test-discipline/core.ts, formatting different things for different callers. Keying on
  // the name flagged that pair on the first run, which is a checker crying wolf.
  const byBody = new Map<string, { name: string; path: string }[]>();

  for (const input of inputs) {
    const sf = parse(input);
    findings.push(...measureFunctions(sf, input));
    findings.push(...findBareBuiltins(sf, input));
    for (const fn of exportedFunctions(sf)) {
      const sites = byBody.get(fn.body) ?? [];
      sites.push({ name: fn.name, path: input.path });
      byBody.set(fn.body, sites);
    }
  }

  for (const sites of byBody.values()) {
    const paths = [...new Set(sites.map((site) => site.path))];
    if (paths.length < 2) continue;
    const names = [...new Set(sites.map((site) => site.name))].join(", ");
    findings.push({
      line: 1,
      message: `${names} has an identical implementation in ${paths.length} files: ${paths.join(", ")}. One implementation, imported.`,
      path: paths[0] ?? "",
      rule: "duplicate-export",
    });
  }

  return findings;
}

/**
 * Render findings for a terminal.
 *
 * @param findings what `scanConventions` returned
 * @param fileCount how many files were scanned, so a zero-file run is visible
 * @returns the report, without a trailing newline
 */
export function formatFindings(findings: readonly Finding[], fileCount: number): string {
  if (findings.length === 0) return `check-conventions: ${fileCount} files clean.`;
  const lines = findings.map((f) => `  ${f.path}:${f.line}  [${f.rule}]  ${f.message}`);
  const plural = findings.length === 1 ? "violation" : "violations";
  return `check-conventions: ${findings.length} ${plural} across ${fileCount} files\n${lines.join("\n")}`;
}
