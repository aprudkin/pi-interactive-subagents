#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD_RUNNER_PATH = fileURLToPath(new URL("./run-child.mjs", import.meta.url));
const configPath = process.argv[2];
if (!configPath) process.exit(125);

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  process.exit(125);
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function baseRecord(kind) {
  return {
    version: 1,
    kind,
    runId: config.runId,
    token: config.token,
    sessionFile: config.sessionFile,
    writtenAt: Date.now(),
  };
}

function cancellationRequested() {
  if (!existsSync(config.cancellationFile)) return false;
  try {
    const record = JSON.parse(readFileSync(config.cancellationFile, "utf8"));
    return record?.version === 1 &&
      record.kind === "cancellation" &&
      record.runId === config.runId &&
      record.token === config.token &&
      record.sessionFile === config.sessionFile;
  } catch {
    return false;
  }
}

let child;
let exitWritten = false;
let terminating = false;
let killTimer;
let groupExitTimer;

function writeStart(childPid = null) {
  writeAtomic(config.startFile, {
    ...baseRecord("process-start"),
    supervisorPid: process.pid,
    childPid,
    configFile: configPath,
    childRunnerFile: CHILD_RUNNER_PATH,
  });
}

function writeExit(exitCode, signal, errorMessage) {
  if (exitWritten) return;
  exitWritten = true;
  writeAtomic(config.exitFile, {
    ...baseRecord("process-exit"),
    exitCode,
    ...(signal ? { signal } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  });
}

function signalGroup(signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch {}
}

function processGroupExists() {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function finish(exitCode, signal) {
  if (killTimer) clearTimeout(killTimer);
  if (groupExitTimer) clearInterval(groupExitTimer);
  try {
    writeExit(exitCode, signal ?? undefined);
  } catch {
    process.exit(126);
  }
  process.exit(exitCode);
}

function finishAfterGroupExit(exitCode, signal) {
  if (!processGroupExists()) {
    finish(exitCode, signal);
    return;
  }
  groupExitTimer = setInterval(() => {
    if (!processGroupExists()) finish(exitCode, signal);
  }, 25);
}

function beginTermination(signal) {
  if (terminating) return;
  terminating = true;
  signalGroup(signal);
  killTimer = setTimeout(() => signalGroup("SIGKILL"), config.terminationGraceMs ?? 1000);
}

process.on("SIGTERM", () => beginTermination("SIGTERM"));
process.on("SIGINT", () => beginTermination("SIGINT"));
process.on("SIGHUP", () => beginTermination("SIGHUP"));

// Publish supervisor ownership before child creation. A parent cancellation can
// now be recorded and the supervisor can be signalled without a pre-start gap.
try {
  writeStart();
} catch {
  process.exit(125);
}

if (cancellationRequested()) {
  try { writeExit(143, "SIGTERM", "Cancelled before child spawn"); } catch {}
  process.exit(143);
}

try {
  child = spawn(process.execPath, [CHILD_RUNNER_PATH, configPath], {
    detached: true,
    stdio: "inherit",
    env: process.env,
  });
} catch (error) {
  try { writeExit(127, undefined, error instanceof Error ? error.message : String(error)); } catch {}
  process.exit(127);
}

child.once("spawn", () => {
  try {
    writeStart(child.pid);
    if (terminating) signalGroup("SIGTERM");
    else if (cancellationRequested()) beginTermination("SIGTERM");
  } catch {
    signalGroup("SIGKILL");
    try { writeExit(125, undefined, "Failed to publish child process identity"); } catch {}
    process.exit(125);
  }
});

child.once("error", (error) => {
  try { writeExit(127, undefined, error.message); } catch {}
  process.exitCode = 127;
});

child.once("close", (code, signal) => {
  const exitCode = typeof code === "number" ? code : signal ? 128 : 1;
  if (terminating) {
    // The group leader can exit before resistant payload processes. Keep the
    // verified group ownership and escalation timer until the whole group is gone.
    finishAfterGroupExit(exitCode, signal);
    return;
  }
  finish(exitCode, signal);
});
