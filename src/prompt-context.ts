import { Buffer } from "node:buffer";
import { estimateTokens, findCodebaseMap } from "./files.ts";

export type PromptContextComponentKind = "map_wrapper" | "codebase_map" | "task_prompt";

export interface PromptContextTextEstimate {
  bytes: number;
  estimatedTokens: number;
}

export interface CartographerMapMetadata {
  totalTokens: number | null;
}

export interface PromptContextComponent extends PromptContextTextEstimate {
  kind: PromptContextComponentKind;
  label: string;
}

export interface PromptContextMapAccounting extends PromptContextTextEstimate {
  included: boolean;
  path: string | null;
  cartographerTotalTokens: number | null;
  /** Case variants of the resolved map that also exist and were not chosen. */
  ambiguousWith: string[];
}

export interface PromptContextAccounting extends PromptContextTextEstimate {
  taskPrompt: PromptContextTextEstimate;
  map: PromptContextMapAccounting;
  components: PromptContextComponent[];
}

export interface BuildPromptContextOptions {
  taskPrompt: string;
  includeMap?: boolean;
  cwd?: string;
  mapContent?: string | null;
  mapPath?: string | null;
}

export interface BuiltPromptContext {
  prompt: string;
  accounting: PromptContextAccounting;
}

const MAP_PREFIX = "## Codebase Map\n\n";
const MAP_SUFFIX = "\n\n---\n\n";

export function estimatePromptText(text: string): PromptContextTextEstimate {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokens(text),
  };
}

export function readCartographerMapMetadata(mapContent: string): CartographerMapMetadata {
  const frontmatter = mapContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) {
    return { totalTokens: null };
  }

  for (const line of frontmatter.split(/\r?\n/)) {
    const fieldMatch = line.match(/^total_tokens:\s*(.+?)\s*$/);
    if (!fieldMatch) {
      continue;
    }

    const normalized = (fieldMatch[1] ?? "").replace(/["',_]/g, "");
    const totalTokens = Number.parseInt(normalized, 10);
    return { totalTokens: Number.isFinite(totalTokens) ? totalTokens : null };
  }

  return { totalTokens: null };
}

/**
 * A codebase map that is definitely present and non-empty.
 *
 * `null` rather than an empty content string is what the assembler is given for "no map", so the
 * distinction between "no map wanted", "none found" and "found but empty" is resolved once, in
 * the shell, instead of being re-derived from a falsy string further in.
 */
export interface ResolvedCodebaseMap {
  readonly content: string;
  readonly path: string | null;
  /** Case variants of the resolved map that also exist and were not chosen. */
  readonly ambiguousWith: readonly string[];
}

/**
 * Assemble the prompt and its accounting. Pure: no filesystem, no cwd, no clock.
 *
 * This is the half worth testing — the byte and token accounting that `--dry-run` prints and
 * that decides whether a 23KB map is silently doubling the size of a planning prompt. It used to
 * be reachable only through a function that hit the disk first.
 *
 * @param taskPrompt the caller's prompt, always last in the assembled text
 * @param map the resolved map, or null for no map at all
 * @returns the assembled prompt plus its full accounting
 */
export function assemblePromptContext(taskPrompt: string, map: ResolvedCodebaseMap | null): BuiltPromptContext {
  const taskComponent = buildComponent("task_prompt", "Task prompt", taskPrompt);
  const components: PromptContextComponent[] = [];
  const options = { taskPrompt };
  const mapContent = map?.content ?? null;
  const mapPath = map?.path ?? null;
  const mapAmbiguousWith = [...(map?.ambiguousWith ?? [])];

  if (!mapContent) {
    components.push(taskComponent);
    const promptEstimate = estimatePromptText(options.taskPrompt);
    return {
      accounting: {
        ...promptEstimate,
        components,
        map: {
          ambiguousWith: [],
          bytes: 0,
          cartographerTotalTokens: null,
          estimatedTokens: 0,
          included: false,
          path: null,
        },
        taskPrompt: estimatePromptText(options.taskPrompt),
      },
      prompt: options.taskPrompt,
    };
  }

  const mapWrapper = `${MAP_PREFIX}${MAP_SUFFIX}`;
  const mapComponent = buildComponent("codebase_map", "Codebase map", mapContent);
  const wrapperComponent = buildComponent("map_wrapper", "Codebase map wrapper", mapWrapper);
  components.push(wrapperComponent, mapComponent, taskComponent);

  const prompt = `${MAP_PREFIX}${mapContent}${MAP_SUFFIX}${options.taskPrompt}`;
  const promptEstimate = estimatePromptText(prompt);
  const metadata = readCartographerMapMetadata(mapContent);

  return {
    accounting: {
      ...promptEstimate,
      components,
      map: {
        ambiguousWith: mapAmbiguousWith,
        bytes: mapComponent.bytes,
        cartographerTotalTokens: metadata.totalTokens,
        estimatedTokens: mapComponent.estimatedTokens,
        included: true,
        path: mapPath,
      },
      taskPrompt: estimatePromptText(options.taskPrompt),
    },
    prompt,
  };
}

/**
 * Resolve which map, if any, this invocation is using. The only effectful step.
 *
 * Three cases, and they were previously tangled with the assembly: no map asked for, a map
 * supplied inline by the caller (which `--dry-run` and the tests use), or a lookup against the
 * working directory. An empty map file collapses to null here so the assembler sees one shape.
 */
async function resolveCodebaseMap(options: BuildPromptContextOptions): Promise<ResolvedCodebaseMap | null> {
  if (!options.includeMap) return null;

  if (options.mapContent !== undefined) {
    if (!options.mapContent) return null;
    return { ambiguousWith: [], content: options.mapContent, path: options.mapPath ?? null };
  }

  const map = await findCodebaseMap(options.cwd ?? process.cwd());
  if (!map?.content) return null;
  return { ambiguousWith: map.ambiguousWith ?? [], content: map.content, path: map.path ?? null };
}

/** Resolve the map, then assemble. The effectful shell over {@link assemblePromptContext}. */
export async function buildPromptContext(options: BuildPromptContextOptions): Promise<BuiltPromptContext> {
  return assemblePromptContext(options.taskPrompt, await resolveCodebaseMap(options));
}

function buildComponent(kind: PromptContextComponentKind, label: string, text: string): PromptContextComponent {
  return {
    kind,
    label,
    ...estimatePromptText(text),
  };
}
