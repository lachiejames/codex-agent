// Configuration for codex-agent

export const config = {
  // LOCAL OVERRIDE (was upstream's "low") — same reason. Raise/lower per call with `-r` if ever needed.
  defaultReasoningEffort: "xhigh" as const,

  // LOCAL OVERRIDE (was upstream's "workspace-write"). Codex is the BRAIN here, not the
  // hands: it plans and it reviews, and Claude does the writing. A planner and a
  // reviewer never need write access, so read-only is the correct default and write is
  // the thing you opt into deliberately with `-s workspace-write`.
  //
  // This also removes a whole class of accident. Upstream's default let every spawned
  // agent modify the tree, including the review passes whose entire job is to look.
  defaultSandbox: "read-only" as const,

  // Job storage directory
  jobsDir: `${process.env["HOME"]}/.codex-agent/jobs`,
  jobsIndexFile: `${process.env["HOME"]}/.codex-agent/jobs/index.json`,
  // Default model. LOCAL OVERRIDE (was upstream's "gpt-5.5"): these agents exist to catch what a green
  // suite does not, so they get the strongest model available rather than the cheapest.
  // NOTE: buildCodexArgs passes this as `-c model=...`, which OVERRIDES ~/.codex/config.toml — so this
  // line, not that file, is what every plugin-launched agent actually uses.
  model: "gpt-5.6-sol",

  // Reasoning effort levels
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,

  // Default number of runs to show in listings
  runsListLimit: 20,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
};

export type ReasoningEffort = (typeof config.reasoningEfforts)[number];
export type SandboxMode = (typeof config.sandboxModes)[number];
