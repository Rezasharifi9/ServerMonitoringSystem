import { readWorkspace, writeWorkspace, type Workspace } from "./database";
import { auditOf } from "@/stores/runtime";
import type { DatabaseSync } from "node:sqlite";

export function projectSpeedtest(state: Workspace, now = Date.now()): Workspace {
  const run = state.speedtestRun;
  const pending = state.pendingSpeedtest;
  if (!run?.running || !pending) return state;
  const elapsedSec = Math.min(run.config.durationSec, Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 500) / 2));
  const samples = pending.result.samples.filter((sample) => sample.t <= elapsedSec);
  return { ...state, speedtestRun: { ...run, elapsedSec, samples, currentMbps: samples.at(-1)?.mbps ?? 0 } };
}

export function settleSpeedtest(db: DatabaseSync) {
  const current = readWorkspace(db);
  const state = projectSpeedtest(current.state);
  const pending = state.pendingSpeedtest;
  if (!pending || !state.speedtestRun || state.speedtestRun.elapsedSec < pending.result.durationSec) return current;
  const next: Workspace = {
    ...state,
    speedtestRun: { ...state.speedtestRun, running: false },
    pendingSpeedtest: null,
    speedtests: [pending.result, ...state.speedtests].slice(0, 40),
    audit: [auditOf({ ...state, currentUserId: pending.actor }, "speedtest.finish", pending.result.mode, "تست نمایشی کامل شد."), ...state.audit].slice(0, 2000),
  };
  writeWorkspace(db, next, current.revision + 1);
  return { revision: current.revision + 1, state: next };
}
