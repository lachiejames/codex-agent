// File utilities for codebase map injection.
//
// The map lookup used to be filesystem-dependent, which made it lie.
//
// It tried three literal paths with `readFileSync` — `docs/CODEBASE_MAP.md`,
// `CODEBASE_MAP.md`, `docs/ARCHITECTURE.md` — and returned the path it had *asked* for.
// On macOS's case-insensitive APFS, asking for `docs/ARCHITECTURE.md` happily opens
// `docs/architecture.md`. So a repo with none of the three intended maps, but a lowercase
// `docs/architecture.md`, silently got ~6KB of an architecture document nobody chose
// injected into every `--map` planning prompt — and the same invocation on a
// case-sensitive filesystem injected nothing at all. Identical command, different
// context, no warning either way.
//
// Worse, the path it reported did not exist. `findCodebaseMap` returned
// `.../docs/ARCHITECTURE.md` while the actual directory entry was `.../docs/architecture.md`,
// so reporting the path without fixing the lookup would just have printed a fabrication.
//
// The fix is to match against the real directory entries rather than to guess casings.
// Adding lowercase candidates to the list was the cheaper option and would not have worked:
// on a case-insensitive filesystem `docs/CODEBASE_MAP.md` still resolves to
// `docs/codebase_map.md` and still reports the casing it asked for, and enumerating
// variants never covers `Architecture.md` or `ARCHITECTURE.MD`. Reading the directory gives
// the same answer on both kinds of filesystem, returns the name that is actually on disk,
// and is the only version that can notice several case variants existing at once.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CodebaseMapFile {
  /** The real path, as it exists on disk — never a casing that was merely asked for. */
  path: string;
  content: string;
  /**
   * Other case variants of the same name that also exist and were not chosen.
   *
   * Only reachable on a case-sensitive filesystem, where `docs/ARCHITECTURE.md` and
   * `docs/architecture.md` can both exist. Surfaced rather than silently resolved, because
   * "which file did I actually get" is the whole point of this module.
   */
  ambiguousWith: string[];
}

/**
 * Candidate map locations, in priority order.
 *
 * `docs/ARCHITECTURE.md` used to be a third fallback here, inherited from upstream. It is gone.
 * A repo with no codebase map but any architecture document would have that document silently
 * injected into a planning prompt — a different artifact, written for a different audience, at
 * whatever token cost it happened to carry. `--map` now means the codebase map or nothing, and
 * says which it found.
 */
const MAP_CANDIDATES = ["docs/CODEBASE_MAP.md", "CODEBASE_MAP.md"] as const;

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

export interface EntryChoice {
  chosen: string;
  others: string[];
}

/**
 * Choose which of a directory's entries satisfies a wanted name, ignoring case.
 *
 * Pure on purpose. This is the only part of the lookup whose behaviour differs between a
 * case-sensitive and a case-insensitive filesystem, and it is the part worth testing hardest
 * — so it takes the listing as data rather than reading a directory. Tests pass synthetic
 * listings and run identically on every machine, instead of skipping when the local
 * filesystem cannot represent two entries differing only by case.
 *
 * When several entries match, an exact-case match to the wanted name wins and the rest are
 * reported as ambiguous; ordering is otherwise lexicographic, so the choice never depends on
 * directory iteration order.
 */
export function chooseEntry({ entries, wantedName }: { entries: string[]; wantedName: string }): EntryChoice | null {
  const wantedLower = wantedName.toLowerCase();
  const matches = entries.filter((entry) => entry.toLowerCase() === wantedLower).toSorted();

  const [firstMatch] = matches;
  if (firstMatch === undefined) return null;

  const chosen = matches.find((entry) => entry === wantedName) ?? firstMatch;
  return { chosen, others: matches.filter((entry) => entry !== chosen) };
}

/**
 * Resolve one path segment against the real entries of its parent.
 *
 * The effectful shell around `chooseEntry`: it lists the directory and discards entries of
 * the wrong kind — a directory merely named like a map is not a map — then defers the actual
 * choice to the pure function.
 */
function resolveSegment(parent: string, wantedName: string, wantDirectory: boolean): EntryChoice | null {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return null;
  }

  const usable = entries.filter((entry) => {
    try {
      const stat = statSync(join(parent, entry));
      return wantDirectory ? stat.isDirectory() : stat.isFile();
    } catch {
      return false;
    }
  });

  return chooseEntry({ entries: usable, wantedName });
}

/**
 * Resolve a candidate to the path that is actually on disk, one segment at a time.
 *
 * EVERY segment is resolved, not just the filename. An adversarial pass caught the first
 * version doing only the basename: a repo with `Docs/CODEBASE_MAP.md` still resolved through
 * the requested `docs` on a case-insensitive filesystem, returned a path with a fabricated
 * directory casing, and found nothing at all on a case-sensitive one. That is the same
 * defect this module exists to remove, one level up the path — so the walk covers the whole
 * path rather than its last component.
 */
function resolveCandidate(cwd: string, candidate: string): { path: string; ambiguousWith: string[] } | null {
  const segments = candidate.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return null;

  let current = resolve(cwd);
  const ambiguousWith: string[] = [];

  for (const [index, segment] of segments.entries()) {
    const isFinalSegment = index === segments.length - 1;
    const match = resolveSegment(current, segment, !isFinalSegment);
    if (!match) return null;

    ambiguousWith.push(...match.others.map((other) => join(current, other)));
    current = join(current, match.chosen);
  }

  return { ambiguousWith: ambiguousWith.map(canonicalise), path: canonicalise(current) };
}

/**
 * Reduce a path to the one the filesystem itself reports.
 *
 * The segment walk above only canonicalises the segments it walks — the `cwd` prefix arrives
 * from `process.cwd()` or a `-d` flag and can carry any casing the caller typed. A third
 * adversarial pass used exactly that: real directory `/tmp/Repo`, called as `/tmp/repo`, and
 * the reported path kept the requested `repo`.
 *
 * `realpathSync.native` asks the filesystem for the true name of every component, which ends
 * the whole class rather than one more instance of it. It also resolves symlinks, so a repo
 * reached through a symlink is reported at its real location — correct for a line whose only
 * job is to say which bytes were read, and worth knowing because this repo is itself reached
 * through `~/.codex-orchestrator`.
 */
function canonicalise(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    // Raced away between the walk and here; the un-canonicalised path is still the best
    // answer available and the caller will fail on the read instead.
    return target;
  }
}

export async function findCodebaseMap(cwd: string): Promise<CodebaseMapFile | null> {
  for (const candidate of MAP_CANDIDATES) {
    const resolved = resolveCandidate(cwd, candidate);
    if (!resolved) continue;

    try {
      const content = readFileSync(resolved.path, "utf-8");
      return { ambiguousWith: resolved.ambiguousWith, content, path: resolved.path };
    } catch {
      // Unreadable despite existing — fall through to the next candidate.
    }
  }

  return null;
}

export async function loadCodebaseMap(cwd: string): Promise<string | null> {
  const map = await findCodebaseMap(cwd);
  return map?.content ?? null;
}
