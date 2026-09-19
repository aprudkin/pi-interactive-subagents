/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunControlIdentity } from "./control.ts";
import {
  inspectSupervisorProcess,
  readCompletionRecord,
  readProcessExitRecord,
  readProcessStartRecord,
  type ProcessStartRecord,
  type RunFiles,
} from "./run-state.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

const ROOT_OPTION = "@pi_interactive_subagents_root";
const LAYOUT_MONITOR_KEY = Symbol.for("pi-interactive-subagents/layout-monitor");

interface PaneGeometry {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  root: string;
}

interface LayoutMonitor {
  roots: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
}

const layoutMonitor: LayoutMonitor = (() => {
  const existing = (globalThis as any)[LAYOUT_MONITOR_KEY] as LayoutMonitor | undefined;
  if (existing) return existing;
  const created: LayoutMonitor = { roots: new Set(), timer: null };
  (globalThis as any)[LAYOUT_MONITOR_KEY] = created;
  return created;
})();

function paneRoot(surface: string): string | null {
  try {
    const value = execFileSync(
      "tmux",
      ["show-options", "-p", "-q", "-v", "-t", surface, ROOT_OPTION],
      { encoding: "utf8" },
    ).trim();
    return value.startsWith("%") ? value : null;
  } catch {
    return null;
  }
}

function listWindowPanes(root: string): PaneGeometry[] {
  const output = execFileSync(
    "tmux",
    [
      "list-panes",
      "-t",
      root,
      "-F",
      `#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{${ROOT_OPTION}}`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [id, left, top, width, height, paneLayoutRoot = ""] = line.split("\t");
    return {
      id,
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
      root: paneLayoutRoot,
    };
  });
}

function getLayoutRoot(surface: string): string {
  return paneRoot(surface) ?? surface;
}

/**
 * Restore the managed layout without running select-layout over arbitrary
 * panes. The root Pi pane and panes tagged with its id are one ownership scope.
 * If anything else shares the window, leave that manual layout alone.
 */
function rebalanceRoot(root: string): boolean {
  try {
    const panes = listWindowPanes(root);
    if (!panes.some((pane) => pane.id === root)) return false;

    const owned = panes
      .filter((pane) => pane.id !== root && pane.root === root)
      .sort((a, b) => a.top - b.top || a.left - b.left);
    if (owned.length === 0) return false;

    // A foreign pane means this is no longer an exclusively managed window.
    // Targeted splits may coexist with it, but must not rewrite its geometry.
    if (panes.some((pane) => pane.id !== root && pane.root !== root)) return true;

    const main = panes.find((pane) => pane.id === root)!;
    const windowWidth = Math.max(...panes.map((pane) => pane.left + pane.width));
    const windowHeight = Math.max(...panes.map((pane) => pane.top + pane.height));

    // One cell is the vertical separator. Give an odd spare content cell to
    // the main pane, so the left side is never narrower than the right side.
    const mainWidth = Math.ceil((windowWidth - 1) / 2);
    if (main.width !== mainWidth) {
      execFileSync("tmux", ["resize-pane", "-t", root, "-x", String(mainWidth)], {
        encoding: "utf8",
      });
    }

    // The right stack has one horizontal separator between adjacent panes.
    const availableHeight = windowHeight - (owned.length - 1);
    const baseHeight = Math.floor(availableHeight / owned.length);
    const extraCells = availableHeight % owned.length;
    for (let index = 0; index < owned.length; index += 1) {
      const height = baseHeight + (index < extraCells ? 1 : 0);
      if (owned[index].height !== height) {
        execFileSync("tmux", ["resize-pane", "-t", owned[index].id, "-y", String(height)], {
          encoding: "utf8",
        });
      }
    }
    return true;
  } catch {
    // A pane or window can disappear between queries. Layout is best-effort
    // and must never turn a cosmetic resize into a lifecycle failure.
    return false;
  }
}

function monitorLayouts(): void {
  for (const root of [...layoutMonitor.roots]) {
    if (!rebalanceRoot(root)) layoutMonitor.roots.delete(root);
  }
  if (layoutMonitor.roots.size === 0 && layoutMonitor.timer) {
    clearInterval(layoutMonitor.timer);
    layoutMonitor.timer = null;
  }
}

function watchLayout(root: string): void {
  layoutMonitor.roots.add(root);
  rebalanceRoot(root);
  if (layoutMonitor.timer) return;
  layoutMonitor.timer = setInterval(monitorLayouts, 500);
  layoutMonitor.timer.unref?.();
}

function markOwnedSurface(surface: string, root: string): void {
  execFileSync("tmux", ["set-option", "-p", "-t", surface, ROOT_OPTION, root], {
    encoding: "utf8",
  });
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent. The first pane splits right from the root
 * Pi pane; later and nested panes split the largest pane in the owned stack.
 * Explicit targets make placement independent of focus and pane index.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  requireTmux();
  const parent = process.env.TMUX_PANE;
  if (!parent) throw new Error("TMUX_PANE is required to place a subagent pane");

  const root = getLayoutRoot(parent);
  const owned = listWindowPanes(root)
    .filter((pane) => pane.id !== root && pane.root === root)
    .sort((a, b) => b.height - a.height || a.top - b.top);

  // The first child forms the right column. Later children divide the largest
  // right-column pane vertically, preserving the root as a full-height left pane.
  const target = owned[0]?.id ?? root;
  const pane = createSurfaceSplit(name, owned.length === 0 ? "right" : "down", target);
  try {
    markOwnedSurface(pane, root);
  } catch (error) {
    try { execFileSync("tmux", ["kill-pane", "-t", pane]); } catch {}
    throw error;
  }
  watchLayout(root);
  return pane;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    // Launch scripts contain per-run control credentials. The pane shell only
    // needs owner execution; never expose them to other local users.
    mode: 0o700,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  const root = paneRoot(surface);
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  if (root) watchLayout(root);
}

// ── Exit polling ──

export interface SurfaceIdentity {
  paneId: string;
  panePid: number;
  windowId: string;
}

export function getSurfaceIdentity(surface: string): SurfaceIdentity {
  requireTmux();
  const output = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", surface, "#{pane_id}\t#{pane_pid}\t#{window_id}"],
    { encoding: "utf8" },
  ).trim();
  const [paneId, rawPid, windowId] = output.split("\t");
  const panePid = Number(rawPid);
  if (!paneId?.startsWith("%") || !Number.isInteger(panePid) || !windowId) {
    throw new Error(`Unexpected tmux pane identity: ${output}`);
  }
  return { paneId, panePid, windowId };
}

export interface PollResult {
  reason:
    | "completed"
    | "error"
    | "process-exit"
    | "startup-timeout"
    | "supervisor-lost"
    | "supervisor-reused"
    | "invalid-run-record"
    | "surface-missing"
    | "surface-reused";
  exitCode: number;
  errorMessage?: string;
}

function sameSurface(expected: SurfaceIdentity, actual: SurfaceIdentity): boolean {
  return expected.paneId === actual.paneId && expected.panePid === actual.panePid && expected.windowId === actual.windowId;
}

/**
 * Wait for the per-run wrapper exit sidecar. Completion intent is recorded by
 * the child at `agent_settled`; the wrapper record proves the Pi process has
 * actually exited even though the pane's interactive shell remains alive.
 * Missing and identity-changed panes are explicit failures, never ignored.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    identity: RunControlIdentity;
    runFiles: RunFiles;
    surfaceIdentity: SurfaceIdentity;
    completionRequired?: boolean;
    startupDeadlineMs?: number;
    missingExitRecordGraceMs?: number;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  const startupDeadlineMs = options.startupDeadlineMs ?? 10_000;
  const missingExitRecordGraceMs = options.missingExitRecordGraceMs ?? 500;
  let processStart: ProcessStartRecord | null = null;
  let supervisorMissingSince: number | null = null;

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    const processExit = readProcessExitRecord(options.runFiles.exitFile, options.identity);
    if (processExit) {
      const completion = readCompletionRecord(options.runFiles.completionFile, options.identity);
      if (completion?.status === "error") {
        return {
          reason: "error",
          exitCode: processExit.exitCode || 1,
          errorMessage: completion.errorMessage || "The subagent settled with an agent error.",
        };
      }
      if (completion?.status === "completed" || (!options.completionRequired && processExit.exitCode === 0)) {
        return { reason: "completed", exitCode: processExit.exitCode };
      }
      return {
        reason: "process-exit",
        exitCode: processExit.exitCode || 1,
        errorMessage: "The subagent process exited without an authenticated completion record; the run may be resumed.",
      };
    }

    if (!processStart) {
      processStart = readProcessStartRecord(options.runFiles.startFile, options.identity);
      if (!processStart && existsSync(options.runFiles.startFile)) {
        return {
          reason: "invalid-run-record",
          exitCode: 1,
          errorMessage: "The supervisor start record does not match this run identity; the run may be resumed.",
        };
      }
      if (!processStart && Date.now() - start >= startupDeadlineMs) {
        return {
          reason: "startup-timeout",
          exitCode: 1,
          errorMessage: "The subagent supervisor did not publish a start record before the startup deadline.",
        };
      }
    }

    if (processStart) {
      const supervisorState = inspectSupervisorProcess(processStart);
      if (supervisorState === "reused") {
        return {
          reason: "supervisor-reused",
          exitCode: 1,
          errorMessage: "The recorded supervisor PID now belongs to another process; refusing to observe or terminate it.",
        };
      }
      if (supervisorState === "missing") {
        supervisorMissingSince ??= Date.now();
        if (Date.now() - supervisorMissingSince >= missingExitRecordGraceMs) {
          return {
            reason: "supervisor-lost",
            exitCode: 1,
            errorMessage: "The tracked supervisor exited without its authenticated exit record; the run may be resumed.",
          };
        }
      } else {
        supervisorMissingSince = null;
      }
    }

    let actualIdentity: SurfaceIdentity;
    try {
      actualIdentity = getSurfaceIdentity(surface);
    } catch {
      return {
        reason: "surface-missing",
        exitCode: 1,
        errorMessage: "The subagent tmux pane disappeared before its wrapper wrote an exit record; the run may be resumed.",
      };
    }
    if (!sameSurface(options.surfaceIdentity, actualIdentity)) {
      return {
        reason: "surface-reused",
        exitCode: 1,
        errorMessage: "The tracked tmux target no longer has the identity assigned to this run; refusing to observe or close the replacement pane.",
      };
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
