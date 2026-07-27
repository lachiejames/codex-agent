import { describe, expect, test } from "bun:test";
import { parseCodexTokenUsage } from "./usage-parser.ts";

describe("parseCodexTokenUsage", () => {
  test("parses the observed Codex token usage tail", () => {
    const usage = parseCodexTokenUsage(
      "Token usage: total=13,645 input=13,640 (+ 5,504 cached) output=5",
    );

    expect(usage).toEqual({
      total: 13645,
      input: 13640,
      cached_input: 5504,
      output: 5,
    });
  });

  test("finds the latest usage line in terminal text", () => {
    const usage = parseCodexTokenUsage(
      [
        "some prior output",
        "Token usage: total=100 input=90 output=10",
        "more terminal output",
        "Token usage: total=1,250 input=1,200 (+ 300 cached) output=50",
      ].join("\n"),
    );

    expect(usage).toEqual({
      total: 1250,
      input: 1200,
      cached_input: 300,
      output: 50,
    });
  });

  test("returns null when no token usage line is present", () => {
    expect(parseCodexTokenUsage("no usage here")).toBeNull();
  });
});
