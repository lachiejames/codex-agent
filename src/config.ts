// Configuration for codex-agent

export const config = {
  // Default model. LOCAL OVERRIDE (was upstream's "gpt-5.5"): these agents exist to catch what a green
  // suite does not, so they get the strongest model available rather than the cheapest.
  // NOTE: buildCodexArgs passes this as `-c model=...`, which OVERRIDES ~/.codex/config.toml — so this
  // line, not that file, is what every plugin-launched agent actually uses.
  model: "gpt-5.6-sol",

  // Reasoning effort levels
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  // LOCAL OVERRIDE (was upstream's "low") — same reason. Raise/lower per call with `-r` if ever needed.
  defaultReasoningEffort: "xhigh" as const,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
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

  // Default inactivity timeout in minutes for running jobs
  defaultTimeout: 60,

  // Default WALL-CLOCK bound for a run, in minutes. Distinct from defaultTimeout
  // above, which is an *inactivity* threshold — the 2026-07-26 failure was never
  // inactive (115 exec calls over 110 minutes), so inactivity alone would not have
  // caught it. Nothing bounded total elapsed time, which is why it ran to 1h50m.
  // Per-pass overrides live in contract.ts PASS_PROFILES.
  defaultRunTimeoutMinutes: 30,

  // Minutes with NO progress on any signal — log bytes, token spend, completed turns —
  // before the runaway backstop stops a run. See guards.ts: this is a hang detector, not
  // a cost control, and it is deliberately multi-condition. There is no token ceiling,
  // because the measured evidence does not support one: the plan run judged excellent
  // reported 13.7M tokens and the one judged a catastrophe reported 2.8M.
  runawayStallMinutes: 10,

  // Default number of jobs to show in listings
  jobsListLimit: 20,

  // tmux session prefix
  tmuxPrefix: "codex-agent",

};

export type ReasoningEffort = typeof config.reasoningEfforts[number];
export type SandboxMode = typeof config.sandboxModes[number];
