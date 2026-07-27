export type CodexTokenUsage = {
  total: number;
  input: number;
  cached_input: number;
  output: number;
};

const TOKEN_USAGE_PATTERN =
  /Token usage:\s*total=([\d,]+)\s+input=([\d,]+)(?:\s+\(\+\s*([\d,]+)\s+cached\))?\s+output=([\d,]+)/gi;

function parseTokenCount(value: string): number | null {
  const parsed = Number.parseInt(value.replaceAll(",", ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseCodexTokenUsage(logContent: string): CodexTokenUsage | null {
  let usage: CodexTokenUsage | null = null;

  for (const match of logContent.matchAll(TOKEN_USAGE_PATTERN)) {
    const total = match[1] ? parseTokenCount(match[1]) : null;
    const input = match[2] ? parseTokenCount(match[2]) : null;
    const cachedInput = match[3] ? parseTokenCount(match[3]) : 0;
    const output = match[4] ? parseTokenCount(match[4]) : null;

    if (total === null || input === null || cachedInput === null || output === null) continue;

    usage = {
      total,
      input,
      cached_input: cachedInput,
      output,
    };
  }

  return usage;
}
