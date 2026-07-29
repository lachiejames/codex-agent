import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "./files.ts";
import {
  assemblePromptContext,
  buildPromptContext,
  estimatePromptText,
  readCartographerMapMetadata,
} from "./prompt-context.ts";

describe("readCartographerMapMetadata", () => {
  test("reads total_tokens from Cartographer frontmatter", () => {
    const map = [
      "---",
      "last_mapped: 2026-01-16T21:00:00Z",
      "total_files: 8",
      "total_tokens: 9,094",
      "---",
      "",
      "# Codebase Map",
    ].join("\n");

    expect(readCartographerMapMetadata(map)).toEqual({ totalTokens: 9094 });
  });

  test("returns null metadata when total_tokens is absent", () => {
    expect(readCartographerMapMetadata("# Codebase Map")).toEqual({ totalTokens: null });
  });
});

describe("buildPromptContext", () => {
  test("accounts for a task prompt without a map", async () => {
    const taskPrompt = "Implement the narrow helper.";
    const result = await buildPromptContext({ taskPrompt });

    expect(result.prompt).toBe(taskPrompt);
    expect(result.accounting.bytes).toBe(Buffer.byteLength(taskPrompt, "utf8"));
    expect(result.accounting.estimatedTokens).toBe(estimateTokens(taskPrompt));
    expect(result.accounting.taskPrompt).toEqual(estimatePromptText(taskPrompt));
    expect(result.accounting.map).toEqual({
      ambiguousWith: [],
      bytes: 0,
      cartographerTotalTokens: null,
      estimatedTokens: 0,
      included: false,
      path: null,
    });
    expect(result.accounting.components.map((component) => component.kind)).toEqual(["task_prompt"]);
  });

  test("keeps map estimated tokens separate from Cartographer metadata total_tokens", async () => {
    const taskPrompt = "Build the feature.";
    const map = ["---", "total_tokens: 12000", "---", "", "# Codebase Map", "Short map body."].join("\n");

    const result = await buildPromptContext({
      includeMap: true,
      mapContent: map,
      mapPath: "/tmp/CODEBASE_MAP.md",
      taskPrompt,
    });

    expect(result.prompt).toBe(`## Codebase Map\n\n${map}\n\n---\n\n${taskPrompt}`);
    expect(result.accounting.map).toEqual({
      ambiguousWith: [],
      bytes: Buffer.byteLength(map, "utf8"),
      cartographerTotalTokens: 12000,
      estimatedTokens: estimateTokens(map),
      included: true,
      path: "/tmp/CODEBASE_MAP.md",
    });
    expect(result.accounting.taskPrompt).toEqual(estimatePromptText(taskPrompt));
    expect(result.accounting.estimatedTokens).toBe(estimateTokens(result.prompt));
    expect(result.accounting.map.estimatedTokens).not.toBe(result.accounting.map.cartographerTotalTokens);
    expect(result.accounting.components.map((component) => component.kind)).toEqual([
      "map_wrapper",
      "codebase_map",
      "task_prompt",
    ]);
  });

  test("can load a Cartographer map from the standard docs path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-agent-prompt-context-"));
    const docsDir = join(cwd, "docs");
    mkdirSync(docsDir);

    const map = ["---", "total_tokens: 42", "---", "", "# Loaded Map"].join("\n");
    const mapPath = join(docsDir, "CODEBASE_MAP.md");
    writeFileSync(mapPath, map);

    const result = await buildPromptContext({
      cwd,
      includeMap: true,
      taskPrompt: "Use the loaded map.",
    });

    expect(result.accounting.map.included).toBe(true);
    // The reported path is canonical, so a fabricated casing cannot survive into it. That
    // also resolves symlinks — `mkdtemp` gives `/var/folders/...`, a symlink to
    // `/private/var/folders/...` — which is why this compares against the real path rather
    // than the one the fixture happened to write to.
    expect(result.accounting.map.path).toBe(realpathSync.native(mapPath));
    expect(result.accounting.map.estimatedTokens).toBe(estimateTokens(map));
    expect(result.accounting.map.cartographerTotalTokens).toBe(42);
  });
});

describe("assemblePromptContext", () => {
  test("returns the task prompt alone when there is no map", () => {
    const built = assemblePromptContext("do the thing", null);
    expect(built.prompt).toBe("do the thing");
    expect(built.accounting.map.included).toBe(false);
    expect(built.accounting.map.path).toBe(null);
    expect(built.accounting.map.bytes).toBe(0);
    expect(built.accounting.map.estimatedTokens).toBe(0);
    expect(built.accounting.components.map((c) => c.kind)).toEqual(["task_prompt"]);
  });

  test("wraps the map before the task prompt, in the order Codex receives it", () => {
    const built = assemblePromptContext("do the thing", {
      ambiguousWith: [],
      content: "# Map\n",
      path: "/repo/docs/CODEBASE_MAP.md",
    });
    expect(built.accounting.map.included).toBe(true);
    expect(built.accounting.map.path).toBe("/repo/docs/CODEBASE_MAP.md");
    expect(built.accounting.components.map((c) => c.kind)).toEqual(["map_wrapper", "codebase_map", "task_prompt"]);
    expect(built.prompt.endsWith("do the thing")).toBe(true);
    expect(built.prompt).toContain("# Map\n");
  });

  test("accounts the task prompt separately from the whole prompt", () => {
    const built = assemblePromptContext("abc", { ambiguousWith: [], content: "# Map\n", path: null });
    expect(built.accounting.taskPrompt.bytes).toBe(3);
    expect(built.accounting.bytes).toBeGreaterThan(built.accounting.taskPrompt.bytes);
  });

  test("reports the case variants that were not chosen", () => {
    const built = assemblePromptContext("x", {
      ambiguousWith: ["/repo/docs/codebase_map.md"],
      content: "# Map\n",
      path: "/repo/docs/CODEBASE_MAP.md",
    });
    expect(built.accounting.map.ambiguousWith).toEqual(["/repo/docs/codebase_map.md"]);
  });
});
