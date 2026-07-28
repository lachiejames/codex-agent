#!/usr/bin/env bun

import { updateJobTurn, writeSignalFile, type TurnEvent } from "./watcher.ts";
import { appendAnswer } from "./answer-store.ts";

type NotifyPayload = {
  type?: string;
  [key: string]: unknown;
};

function parsePayload(raw: string): NotifyPayload | null {
  try {
    return JSON.parse(raw) as NotifyPayload;
  } catch {
    return null;
  }
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toStringOrFallback(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function main(): void {
  const jobId = process.argv[2];
  const rawPayload = process.argv[3];
  if (!jobId || !rawPayload) return;

  const payload = parsePayload(rawPayload);
  if (!payload || payload.type !== "agent-turn-complete") return;

  const event: TurnEvent = {
    turnId: toStringOrFallback(payload["turn-id"]),
    lastAgentMessage: toStringOrNull(payload["last-assistant-message"]),
    timestamp: new Date().toISOString(),
  };

  // Persist the answer untruncated BEFORE touching the job record. This is the only
  // moment the full text is available in-process — `updateJobTurn` keeps a 500-character
  // preview for listings, and the terminal is a lossy TUI. If this write is skipped the
  // answer only exists in a live tmux session, which is how a whole planning pass was
  // lost when the tmux server died.
  if (event.lastAgentMessage) {
    appendAnswer(jobId, {
      turnId: event.turnId,
      timestamp: event.timestamp,
      text: event.lastAgentMessage,
    });
  }

  writeSignalFile(jobId, event);
  updateJobTurn(jobId, event);
}

main();
