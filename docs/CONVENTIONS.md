# Conventions

What this repo holds itself to, and which of those a machine checks. Adopted from
`~/dev/personal/slopweaver`, which is the reference implementation for how TypeScript is written
across these projects — but adopted selectively, because that repo is a yarn/vitest multi-lane
application and this one is a single-package Bun CLI.

**Nothing in this file is aspirational.** Every statement was true when it was written, and the
ones a tool enforces say so. A conventions document describing rules nobody checks becomes the
next stale comment; this repo has just finished deleting four of those.

## The one gate

`bun run validate` is the only list of checks that exists. It is `src/gate/core.ts`, and every
door runs it — `git push` via lefthook, CI, and `scripts/verify-install.sh`.

| check             | what it is                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `format`          | biome (code, JSON) + prettier (Markdown, YAML)                     |
| `lint`            | `oxlint --deny-warnings`                                           |
| `typecheck`       | `tsc --noEmit`                                                     |
| `test-discipline` | `src/check-test-discipline` — no skipped, mocked or weak tests     |
| `conventions`     | `src/check-conventions` — function length, `node:`, duplicate code |
| `dead-code`       | `knip`                                                             |
| `test`            | `bun test`                                                         |
| `build`           | `bun build` as a bundleability check, not a release artifact       |

**It does not short-circuit.** One run reports every failure. The predecessor was `a && b && c`,
so a tree with a formatting error and a type error told you about one of them.

CI keeps no list of its own. Reproducing the list is exactly what let three different bars drift
apart: `validate` used to omit knip, CI used to omit lint, format and test-discipline, and
`verify-install.sh` used to omit format, test-discipline and knip.

## Machine-enforced

- **Strict TypeScript**, `tsconfig.json` ported from the reference repo with two Bun deviations
  documented in the file itself. `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noUnusedLocals`.
- **No production function body over 60 lines.** Exemptions are inline —
  `// max-lines-exempt: <reason>` in a comment above the function — and a marker with no reason
  is not an exemption. Inline rather than a central list so the reason sits where the next reader
  is. Six exemptions exist — `prepareLaunch`, `launch`, `main`, `formatRunReport`,
  `watchInvocation`, `supervise` — and each names why splitting that function is worse than its
  length. Nine existed when the rule landed; three were paid off in the same series.
- **`node:` on every builtin import.**
- **No identical exported implementation in two files.** Bodies are compared with comments,
  whitespace and digit-separating underscores normalised away.
- **One formatter per file type.** Biome owns code and JSON, Prettier owns Markdown and YAML.
  `.prettierignore` keeps them from competing.
- **Zero tolerated warnings.** `--deny-warnings` makes an oxlint warning fail the gate.
- **No skipped, focused, mocked or weakly-asserted tests.** `skipIf(` is banned by name. Weak
  assertions take a same-line `// weak-ok: <reason>`; skips and mocks take no exception at all.

## Held by hand

- **Pure core, effectful shell.** `bounds`, `contract`, `event-stream`, `runner`, `report` and the
  mapping half of `run-report` and `prompt-context` are pure. The shells own the clock, the
  filesystem and the process. Where a shell wraps a pure core, the wrapper keeps the caller's
  signature and passes the world in as a parameter.
- **`readonly` at value boundaries.** Decisions, measurements and parsed results are readonly.
  `Run` is deliberately NOT — the supervisor mutates a run in place as it observes it, and
  marking it readonly would be a lie. Where a pure function folds a readonly value it takes a
  local draft type that strips `readonly`, so the only writes are to an object that has not
  escaped (`MetricsDraft` in `event-stream.ts`).
- **Types beside their owner.** No central types file.
- **Named function declarations with explicit return types.** No classes, no default exports, no
  top-level arrows.
- **Comments carry the WHY, and the evidence.** Most headers in `src/` cite the measured failure
  that produced the rule — the 1h50m/115-exec run, the 4.4x token-column ambiguity, the sandbox
  flag asymmetry. Type signatures already say what a function takes; a comment repeating that
  earns nothing.
- **Exact assertions.** `toBe`/`toEqual` on exact values. Fakes are plain functions and fixed
  clocks, never a mock framework — there is no mocking library here and there should not be.

## Deliberately NOT adopted

Cargo-culting a convention that cannot apply is a failure mode the reference repo's own docs warn
about, so these are recorded with reasons.

- **No coverage floor.** `bun test --coverage` works and needs no dependency, but a threshold here
  would institutionalise a misleading number. Measured on this repo: coverage is attributed only
  to the modules tests import directly, so `cli.ts`, `supervisor.ts`, `run-commands.ts` and
  `run-report.ts` are **absent entirely** — the CLI tests spawn a real subprocess and that
  execution is never counted. The headline reads 90% while the four largest effectful modules go
  unmeasured, and `run-store.ts` sits at 10% functions. A concrete way that gate would lie:
  delete the subprocess test covering `--json`, then break `--json` — the number does not move and
  the ratchet passes. Bun also emits no branch metric, so the reference repo's branch floor cannot
  exist here. This is the same reasoning as **no token ceiling** in CLAUDE.md: bound the question,
  not the number. Run `bun test --coverage` when curious; nothing gates on it.
- **No file-length limit.** A ceiling above the largest current file ratifies every existing file
  and permits further growth, which is enforcement theatre. A genuine per-file freeze — every file
  pinned at its current count, reductions only — is the real version and is not worth its
  machinery here yet. Function length and complexity are the properties that matter.
- **No `@ts-expect-error` negative type tests.** The reference repo asserts illegal typestate
  transitions that way. This repo bans the pragma outright, which is the stronger constraint.
- **No `eslint`/`typescript-eslint`.** That would add several devDependencies for type-aware rules;
  oxlint plus the local AST checker covers what this codebase actually needs. Revisit only if a
  specific rule is worth the dependencies.
- **No centralised `src/__tests__/` lane.** Tests are co-located `*.test.ts`. The reference repo
  centralises, and its own testing doc claiming co-location is stale — so its layout is not
  evidence of a convention either way. Co-location works here; moving 15 files would be churn.
- **No yarn constraints, NodeNext resolution, `.js` import suffixes, or Polly cassettes.** Wrong
  package manager, wrong module resolution, no network-recording problem to solve.
- **No named-object parameters as a blanket rule.** The reference repo prescribes them for every
  function taking one or more arguments. 84 functions here take exactly one parameter; wrapping
  those in an object adds ceremony and call-site churn for no added meaning. Used where grouping
  genuinely helps.
- **No mandatory `@param`/`@returns` on every function.** Explicit signatures already carry the
  types. Documentation is required for reasoning and invariants, not type narration.

## The two decompositions that were declined

`supervise` (109 lines) and `main` (218 lines) keep their exemptions. A plan to decompose them
behind an injected effects object was stress-tested and judged scope creep for a style change:
`supervise` owns exactly one Codex process per turn for a run's whole life, and that sequencing is
the transport's core invariant, while `main` owns the exit-code taxonomy that `docs/SPEC.md` pins.
Both are separately reviewable follow-ups, not drive-by refactors — this repo is the single access
door to Codex for every project on the machine.
