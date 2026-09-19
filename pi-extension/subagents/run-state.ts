import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunControlIdentity } from "./control.ts";

const SUPERVISOR_PATH = fileURLToPath(new URL("./run-supervisor.mjs", import.meta.url));
const CHILD_RUNNER_PATH = fileURLToPath(new URL("./run-child.mjs", import.meta.url));

export interface RunFiles {
  directory: string;
  completionFile: string;
  startFile: string;
  exitFile: string;
  cancellationFile: string;
  supervisorConfigFile: string;
}

interface IdentityRecord {
  version: 1;
  runId: string;
  token: string;
  sessionFile: string;
  writtenAt: number;
}

export interface CompletionRecord extends IdentityRecord {
  kind: "completion";
  status: "completed" | "error";
  errorMessage?: string;
}

export interface ProcessStartRecord extends IdentityRecord {
  kind: "process-start";
  supervisorPid: number;
  childPid: number | null;
  configFile: string;
  childRunnerFile: string;
}

export interface ProcessExitRecord extends IdentityRecord {
  kind: "process-exit";
  exitCode: number;
  signal?: string;
  errorMessage?: string;
}

interface SupervisorConfig {
  version: 1;
  runId: string;
  token: string;
  sessionFile: string;
  command: string;
  startFile: string;
  exitFile: string;
  cancellationFile: string;
  terminationGraceMs: number;
}

export type SupervisorProcessState = "running" | "missing" | "reused";

export function getRunFiles(artifactDir: string, runId: string): RunFiles {
  const directory = join(artifactDir, "subagent-runs", runId);
  return {
    directory,
    completionFile: join(directory, "completion.json"),
    startFile: join(directory, "process-start.json"),
    exitFile: join(directory, "process-exit.json"),
    cancellationFile: join(directory, "cancellation.json"),
    supervisorConfigFile: join(directory, "supervisor.json"),
  };
}

function writeAtomic(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function identityFields(identity: RunControlIdentity) {
  return {
    version: 1 as const,
    runId: identity.runId,
    token: identity.token,
    sessionFile: identity.sessionFile,
    writtenAt: Date.now(),
  };
}

export function writeCompletionRecord(
  path: string,
  identity: RunControlIdentity,
  status: "completed" | "error",
  errorMessage?: string,
): void {
  writeAtomic(path, {
    ...identityFields(identity),
    kind: "completion",
    status,
    ...(errorMessage ? { errorMessage } : {}),
  } satisfies CompletionRecord);
}

export function writeProcessExitRecord(
  path: string,
  identity: RunControlIdentity,
  exitCode: number,
): void {
  writeAtomic(path, {
    ...identityFields(identity),
    kind: "process-exit",
    exitCode,
  } satisfies ProcessExitRecord);
}

function readRecord(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function matchesIdentity(record: any, identity: RunControlIdentity): boolean {
  return (
    record?.version === 1 &&
    record.runId === identity.runId &&
    record.token === identity.token &&
    record.sessionFile === identity.sessionFile
  );
}

export function readCompletionRecord(
  path: string,
  identity: RunControlIdentity,
): CompletionRecord | null {
  const record = readRecord(path) as CompletionRecord | null;
  if (!matchesIdentity(record, identity) || record?.kind !== "completion") return null;
  if (record.status !== "completed" && record.status !== "error") return null;
  return record;
}

export function readProcessStartRecord(
  path: string,
  identity: RunControlIdentity,
): ProcessStartRecord | null {
  const record = readRecord(path) as ProcessStartRecord | null;
  if (!matchesIdentity(record, identity) || record?.kind !== "process-start") return null;
  if (!Number.isInteger(record.supervisorPid) || record.supervisorPid <= 0) return null;
  if (record.childPid !== null && (!Number.isInteger(record.childPid) || record.childPid <= 0)) return null;
  if (record.configFile !== join(dirname(path), "supervisor.json")) return null;
  if (record.childRunnerFile !== CHILD_RUNNER_PATH) return null;
  return record;
}

export function readProcessExitRecord(
  path: string,
  identity: RunControlIdentity,
): ProcessExitRecord | null {
  const record = readRecord(path) as ProcessExitRecord | null;
  if (!matchesIdentity(record, identity) || record?.kind !== "process-exit") return null;
  if (!Number.isInteger(record.exitCode)) return null;
  return record;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveSupervisorNode(): string {
  // A long-lived parent can outlive its versioned executable after an upgrade.
  // Resolve per launch, not at module load; retain the known runtime when usable.
  if (isExecutableFile(process.execPath)) return process.execPath;

  // Match the first executable node in the parent's explicit PATH entries.
  // Keep the absolute alias (e.g. a stable package-manager symlink), not realpath.
  const candidate = (process.env.PATH ?? "").split(delimiter)
    .filter(Boolean)
    .map((directory) => resolve(directory, "node"))
    .find(isExecutableFile);
  if (candidate) {
    try {
      const version = execFileSync(candidate, ["-p", "process.versions.node"], {
        encoding: "utf8",
        timeout: 1_000,
        killSignal: "SIGKILL",
        maxBuffer: 1_024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      // Keep this floor aligned with package.json engines.node (>=22.19.0).
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      if (match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 19))) {
        return candidate;
      }
    } catch {
      // Do not surface probe output or retry another runtime behind PATH's first.
    }
  }
  throw new Error(
    "Cannot launch subagent supervisor: the parent Node executable is unavailable and " +
    "PATH does not provide a runnable Node >=22.19.0 (probe limit: 1 second). " +
    "Restore Node on PATH or restart Pi with a current Node installation.",
  );
}

export function createSupervisedCommand(
  command: string,
  runFiles: RunFiles,
  identity: RunControlIdentity,
  options: { terminationGraceMs?: number } = {},
): string {
  const nodeExecutable = resolveSupervisorNode();
  const config: SupervisorConfig = {
    version: 1,
    runId: identity.runId,
    token: identity.token,
    sessionFile: identity.sessionFile,
    command,
    startFile: runFiles.startFile,
    exitFile: runFiles.exitFile,
    cancellationFile: runFiles.cancellationFile,
    terminationGraceMs: options.terminationGraceMs ?? 1_000,
  };
  writeAtomic(runFiles.supervisorConfigFile, config);
  return `exec ${shellEscape(nodeExecutable)} ${shellEscape(SUPERVISOR_PATH)} ${shellEscape(runFiles.supervisorConfigFile)}`;
}

function inspectMarkerProcess(pid: number, executable: string, configFile: string): SupervisorProcessState {
  try {
    const processDetails = execFileSync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "state=", "-o", "command="],
      { encoding: "utf8", timeout: 1_000 },
    ).trim();
    const match = /^(\S+)\s+(.*)$/s.exec(processDetails);
    // Darwin appends E while a process exits; zombies start with Z. Neither is
    // a live identity mismatch, and both are safe to treat as gone.
    if (!match || match[1].startsWith("Z") || match[1].includes("E")) return "missing";
    const command = match[2];
    return command.includes(executable) && command.includes(configFile) ? "running" : "reused";
  } catch {
    return "missing";
  }
}

export function inspectSupervisorProcess(record: ProcessStartRecord): SupervisorProcessState {
  return inspectMarkerProcess(record.supervisorPid, SUPERVISOR_PATH, record.configFile);
}

export function inspectSupervisedChildProcess(record: ProcessStartRecord): SupervisorProcessState {
  if (record.childPid === null) return "missing";
  return inspectMarkerProcess(record.childPid, CHILD_RUNNER_PATH, record.configFile);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist cancellation before looking for process records, closing the race in
 * which tmux accepted the launch but the supervisor has not published yet.
 * Both supervisor and child process-group signals are identity-checked.
 */
export async function terminateSupervisedRun(
  runFiles: RunFiles,
  identity: RunControlIdentity,
  options: { graceMs?: number; startupWaitMs?: number } = {},
): Promise<"terminated" | "not-started" | "already-exited" | "identity-mismatch"> {
  if (readProcessExitRecord(runFiles.exitFile, identity)) return "already-exited";
  try {
    writeAtomic(runFiles.cancellationFile, {
      ...identityFields(identity),
      kind: "cancellation",
    });
  } catch {
    // Continue with verified process signals even if durable cancellation fails.
  }

  const startupDeadline = Date.now() + (options.startupWaitMs ?? 500);
  let start: ProcessStartRecord | null = null;
  while (!start && Date.now() < startupDeadline) {
    if (readProcessExitRecord(runFiles.exitFile, identity)) return "terminated";
    start = readProcessStartRecord(runFiles.startFile, identity);
    if (!start) await delay(20);
  }
  if (!start) return "not-started";

  let supervisorSignalled = false;
  let childSignalled = false;
  let sawVerifiedProcess = false;
  const deadline = Date.now() + (options.graceMs ?? 1_500);
  while (Date.now() < deadline) {
    if (readProcessExitRecord(runFiles.exitFile, identity)) return "terminated";
    start = readProcessStartRecord(runFiles.startFile, identity) ?? start;
    const supervisorState = inspectSupervisorProcess(start);
    const childState = inspectSupervisedChildProcess(start);
    if (supervisorState === "running") {
      sawVerifiedProcess = true;
      if (!supervisorSignalled) {
        signalProcess(start.supervisorPid, "SIGTERM");
        supervisorSignalled = true;
      }
    }
    if (start.childPid !== null && childState === "running") {
      sawVerifiedProcess = true;
      if (!childSignalled) {
        signalProcess(-start.childPid, "SIGTERM");
        childSignalled = true;
      }
    }
    if (supervisorState === "missing" && childState === "missing") return "terminated";
    if (childState === "reused") return "identity-mismatch";
    if (supervisorState === "reused" && childState !== "running") return "identity-mismatch";
    await delay(25);
  }

  start = readProcessStartRecord(runFiles.startFile, identity) ?? start;
  const supervisorState = inspectSupervisorProcess(start);
  const childState = inspectSupervisedChildProcess(start);
  if (childState === "reused" || (supervisorState === "reused" && childState !== "running")) {
    return "identity-mismatch";
  }
  if (start.childPid !== null && (
    childState === "running" ||
    (childState === "missing" && supervisorState === "running")
  )) {
    // An authenticated live supervisor retains ownership after its Node group
    // leader exits, so escalation may still target resistant group members.
    signalProcess(-start.childPid, "SIGKILL");
    sawVerifiedProcess = true;
  }
  if (start.childPid === null && supervisorState === "running") {
    signalProcess(start.supervisorPid, "SIGKILL");
    sawVerifiedProcess = true;
  }
  return sawVerifiedProcess ? "terminated" : "identity-mismatch";
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
