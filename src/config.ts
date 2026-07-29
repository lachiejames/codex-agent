// Configuration for codex-agent

export const config = {
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
  // THE PIN. Codex is used here for thinking and nothing else, so it always gets the strongest
  // thinker available. There is deliberately NO CLI flag for either of these — see docs/SPEC.md
  // behaviour 2. A flag that can lower them is a footgun: you would ask for a check and quietly
  // get a worse thinker than every other pass.
  //
  // THIS IS THE ONE PLACE TO CHANGE ON A CODEX UPGRADE. Bump both lines together.
  reasoningEffort: "xhigh" as const,

  // Default number of runs to show in listings
  runsListLimit: 20,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
};

/**
 * The efforts Codex accepts.
 *
 * Declared independently of `config` rather than derived from a list of selectable options,
 * because nothing selects any more — this exists so a persisted run record documents what was
 * used, and stays readable if the pin is ever bumped.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type SandboxMode = (typeof config.sandboxModes)[number];
