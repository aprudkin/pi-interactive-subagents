import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeSurface,
  createSurface,
  getSurfaceIdentity,
  pollForExit,
  readScreenAsync,
  sendCommand,
  sendLongCommand,
} from "../../pi-extension/subagents/tmux.ts";
import { createRunControlIdentity } from "../../pi-extension/subagents/control.ts";
import {
  createSupervisedCommand,
  getRunFiles,
  readProcessStartRecord,
  terminateSupervisedRun,
  writeCompletionRecord,
} from "../../pi-extension/subagents/run-state.ts";

const tmuxAvailable = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("fixture condition timed out");
}

if (!tmuxAvailable) {
  it("requires tmux for isolated lifecycle tests", { skip: true }, () => undefined);
} else {
  describe("isolated tmux run lifecycle", { concurrency: 1 }, () => {
    let dir: string;
    let socket: string;
    let oldTmux: string | undefined;
    let oldPane: string | undefined;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "subagent-isolated-tmux-"));
      socket = join(dir, "tmux.sock");
      execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", "120", "-y", "40"]);
      const pid = execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { encoding: "utf8" }).trim();
      const anchorPane = execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pane_id}"], { encoding: "utf8" }).trim();
      oldTmux = process.env.TMUX;
      oldPane = process.env.TMUX_PANE;
      process.env.TMUX = `${socket},${pid},0`;
      process.env.TMUX_PANE = anchorPane;
    });

    after(async () => {
      await delay(200);
      try { execFileSync("tmux", ["-S", socket, "kill-server"]); } catch {}
      if (oldTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = oldTmux;
      if (oldPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = oldPane;
      rmSync(dir, { recursive: true, force: true });
    });

    it("finishes from durable sidecars while the pane shell survives", async () => {
      const surface = createSurface("normal");
      const surfaceIdentity = getSurfaceIdentity(surface);
      const identity = createRunControlIdentity("normal-run", join(dir, "normal.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      const scriptPath = join(dir, "normal-launch.sh");
      sendLongCommand(surface, createSupervisedCommand("sleep 0.1", runFiles, identity), { scriptPath });
      await waitFor(() => existsSync(runFiles.exitFile));
      writeCompletionRecord(runFiles.completionFile, identity, "completed");

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 20,
        identity,
        runFiles,
        surfaceIdentity,
        completionRequired: true,
      });
      assert.deepEqual(result, { reason: "completed", exitCode: 0 });

      const marker = `SHELL_SURVIVED_${Date.now()}`;
      sendCommand(surface, `printf '${marker}\\n'`);
      await waitFor(() => execFileSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", surface], { encoding: "utf8" }).includes(marker));
      assert.match(await readScreenAsync(surface, 30), new RegExp(marker));
      closeSurface(surface);
    });

    it("reports a crashed child process without inventing completion", async () => {
      const surface = createSurface("crash");
      const surfaceIdentity = getSurfaceIdentity(surface);
      const identity = createRunControlIdentity("crash-run", join(dir, "crash.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      await delay(100);
      sendLongCommand(surface, createSupervisedCommand("exit 7", runFiles, identity), { scriptPath: join(dir, "crash-launch.sh") });

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 20,
        identity,
        runFiles,
        surfaceIdentity,
        completionRequired: true,
      });
      assert.equal(result.reason, "process-exit");
      assert.equal(result.exitCode, 7);
      assert.match(result.errorMessage ?? "", /may be resumed/);
      closeSurface(surface);
    });

    it("bounds a failed exit-sidecar writer while the pane shell survives", async () => {
      const surface = createSurface("writer-failure");
      const surfaceIdentity = getSurfaceIdentity(surface);
      const identity = createRunControlIdentity("writer-failure-run", join(dir, "writer.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      mkdirSync(runFiles.exitFile, { recursive: true });
      sendLongCommand(surface, createSupervisedCommand("exit 0", runFiles, identity), { scriptPath: join(dir, "writer-launch.sh") });

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 20,
        identity,
        runFiles,
        surfaceIdentity,
        startupDeadlineMs: 1_000,
        missingExitRecordGraceMs: 50,
      });
      assert.equal(result.reason, "supervisor-lost");
      assert.match(result.errorMessage ?? "", /without its authenticated exit record/);

      const marker = `WRITER_FAILURE_SHELL_${Date.now()}`;
      sendCommand(surface, `printf '${marker}\\n'`);
      await waitFor(() => execFileSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", surface], { encoding: "utf8" }).includes(marker));
      closeSurface(surface);
    });

    it("bounds a killed supervisor even though the pane shell remains", async () => {
      const surface = createSurface("killed-supervisor");
      const surfaceIdentity = getSurfaceIdentity(surface);
      const identity = createRunControlIdentity("killed-supervisor-run", join(dir, "killed.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      sendLongCommand(surface, createSupervisedCommand("sleep 30", runFiles, identity), { scriptPath: join(dir, "killed-launch.sh") });
      await waitFor(() => typeof readProcessStartRecord(runFiles.startFile, identity)?.childPid === "number");
      const start = readProcessStartRecord(runFiles.startFile, identity);
      assert.ok(start?.childPid);
      process.kill(start.supervisorPid, "SIGKILL");

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 20,
        identity,
        runFiles,
        surfaceIdentity,
        missingExitRecordGraceMs: 50,
      });
      assert.equal(result.reason, "supervisor-lost");
      assert.notEqual(start.childPid, null);
      assert.equal(await terminateSupervisedRun(runFiles, identity, { graceMs: 500 }), "terminated");
      await waitFor(() => {
        try { process.kill(-start.childPid!, 0); return false; } catch { return true; }
      });

      const marker = `KILLED_SUPERVISOR_SHELL_${Date.now()}`;
      sendCommand(surface, `printf '${marker}\\n'`);
      await waitFor(() => execFileSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", surface], { encoding: "utf8" }).includes(marker));
      closeSurface(surface);
    });

    it("terminates a supervised descendant through bounded cancellation", async () => {
      const surface = createSurface("terminate");
      const identity = createRunControlIdentity("terminate-run", join(dir, "terminate.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      sendLongCommand(surface, createSupervisedCommand("sleep 30", runFiles, identity, { terminationGraceMs: 50 }), { scriptPath: join(dir, "terminate-launch.sh") });
      await waitFor(() => existsSync(runFiles.startFile));
      assert.equal(await terminateSupervisedRun(runFiles, identity, { graceMs: 500 }), "terminated");
      await waitFor(() => existsSync(runFiles.exitFile));
      const exit = JSON.parse(readFileSync(runFiles.exitFile, "utf8"));
      assert.equal(exit.kind, "process-exit");
      closeSurface(surface);
    });

    it("keeps cancellation supervision until a resistant payload and descendant exit", async () => {
      const surface = createSurface("resistant-cancellation");
      const identity = createRunControlIdentity("resistant-cancellation-run", join(dir, "resistant.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      const payloadPidFile = join(dir, "resistant-payload.pid");
      const descendantPidFile = join(dir, "resistant-descendant.pid");
      const payloadScript = join(dir, "resistant-payload.sh");
      writeFileSync(payloadScript, `#!/bin/bash
set -eu
trap '' TERM INT HUP
printf '%s\\n' "$$" > "$1"
(
  trap '' TERM INT HUP
  while :; do sleep 1; done
) &
printf '%s\\n' "$!" > "$2"
while :; do sleep 1; done
`);
      let groupId: number | null = null;

      try {
        const command = `exec /bin/bash '${payloadScript}' '${payloadPidFile}' '${descendantPidFile}'`;
        await delay(100);
        sendLongCommand(surface, createSupervisedCommand(command, runFiles, identity, { terminationGraceMs: 100 }), { scriptPath: join(dir, "resistant-launch.sh") });
        await waitFor(() => existsSync(payloadPidFile) && existsSync(descendantPidFile));
        const start = readProcessStartRecord(runFiles.startFile, identity);
        assert.ok(start?.childPid);
        groupId = start.childPid;
        const payloadPid = Number.parseInt(readFileSync(payloadPidFile, "utf8"), 10);
        const descendantPid = Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10);
        assert.equal(processExists(payloadPid), true);
        assert.equal(processExists(descendantPid), true);

        assert.equal(await terminateSupervisedRun(runFiles, identity, { graceMs: 1_000 }), "terminated");
        await waitFor(() => !processExists(payloadPid) && !processExists(descendantPid));
        assert.equal(existsSync(runFiles.exitFile), true);
      } finally {
        if (groupId !== null) {
          try { process.kill(-groupId, "SIGKILL"); } catch {}
        }
        closeSurface(surface);
      }
    });

    it("keeps escalation after the owned group leader is killed during cancellation", async () => {
      const surface = createSurface("killed-group-leader");
      const identity = createRunControlIdentity("killed-group-leader-run", join(dir, "killed-group-leader.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      const payloadPidFile = join(dir, "killed-leader-payload.pid");
      const descendantPidFile = join(dir, "killed-leader-descendant.pid");
      const payloadScript = join(dir, "killed-leader-payload.sh");
      writeFileSync(payloadScript, `#!/bin/bash
set -eu
trap '' TERM INT HUP
printf '%s\\n' "$$" > "$1"
(
  trap '' TERM INT HUP
  while :; do sleep 1; done
) &
printf '%s\\n' "$!" > "$2"
while :; do sleep 1; done
`);
      let groupId: number | null = null;
      let termination: ReturnType<typeof terminateSupervisedRun> | null = null;

      try {
        const command = `exec /bin/bash '${payloadScript}' '${payloadPidFile}' '${descendantPidFile}'`;
        await delay(100);
        sendLongCommand(surface, createSupervisedCommand(command, runFiles, identity, { terminationGraceMs: 500 }), { scriptPath: join(dir, "killed-leader-launch.sh") });
        await waitFor(() => existsSync(payloadPidFile) && existsSync(descendantPidFile));
        const start = readProcessStartRecord(runFiles.startFile, identity);
        assert.ok(start?.childPid);
        groupId = start.childPid;
        const payloadPid = Number.parseInt(readFileSync(payloadPidFile, "utf8"), 10);
        const descendantPid = Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10);

        const cancellationStartedAt = Date.now();
        termination = terminateSupervisedRun(runFiles, identity, { graceMs: 1_500 });
        process.kill(start.childPid, "SIGKILL");
        await delay(75);
        assert.equal(existsSync(runFiles.exitFile), false);
        assert.equal(processExists(payloadPid), true);
        assert.equal(processExists(descendantPid), true);

        assert.equal(await termination, "terminated");
        await waitFor(() => !processExists(payloadPid) && !processExists(descendantPid));
        await waitFor(() => existsSync(runFiles.exitFile));
        assert.ok(Date.now() - cancellationStartedAt < 2_500);
      } finally {
        if (groupId !== null) {
          try { process.kill(-groupId, "SIGKILL"); } catch {}
        }
        if (termination) await termination.catch(() => undefined);
        closeSurface(surface);
      }
    });

    it("refuses to signal a process whose authenticated marker identity does not match", async () => {
      const identity = createRunControlIdentity("identity-mismatch-run", join(dir, "identity-mismatch.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      createSupervisedCommand("sleep 30", runFiles, identity);
      const unrelated = spawn("/bin/sleep", ["30"]);
      await new Promise<void>((resolve, reject) => {
        unrelated.once("spawn", resolve);
        unrelated.once("error", reject);
      });

      try {
        writeFileSync(runFiles.startFile, `${JSON.stringify({
          version: 1,
          kind: "process-start",
          runId: identity.runId,
          token: identity.token,
          sessionFile: identity.sessionFile,
          writtenAt: Date.now(),
          supervisorPid: unrelated.pid,
          childPid: null,
          configFile: runFiles.supervisorConfigFile,
          childRunnerFile: fileURLToPath(new URL("../../pi-extension/subagents/run-child.mjs", import.meta.url)),
        })}\n`);
        assert.equal(
          await terminateSupervisedRun(runFiles, identity, { graceMs: 50 }),
          "identity-mismatch",
        );
        assert.equal(processExists(unrelated.pid!), true);
      } finally {
        unrelated.kill("SIGKILL");
      }
    });

    it("refuses an unrelated live child marker even with an authenticated supervisor", async () => {
      const surface = createSurface("live-child-mismatch");
      const identity = createRunControlIdentity("live-child-mismatch-run", join(dir, "live-child-mismatch.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      await delay(100);
      sendLongCommand(surface, createSupervisedCommand("sleep 30", runFiles, identity, { terminationGraceMs: 100 }), { scriptPath: join(dir, "live-child-mismatch-launch.sh") });
      await waitFor(() => typeof readProcessStartRecord(runFiles.startFile, identity)?.childPid === "number");
      const start = readProcessStartRecord(runFiles.startFile, identity);
      assert.ok(start?.childPid);
      const unrelated = spawn("/bin/sleep", ["30"], { detached: true });
      await new Promise<void>((resolve, reject) => {
        unrelated.once("spawn", resolve);
        unrelated.once("error", reject);
      });

      try {
        writeFileSync(runFiles.startFile, `${JSON.stringify({
          ...start,
          writtenAt: Date.now(),
          childPid: unrelated.pid,
        })}\n`);
        assert.equal(
          await terminateSupervisedRun(runFiles, identity, { graceMs: 500 }),
          "identity-mismatch",
        );
        assert.equal(processExists(unrelated.pid!), true);
      } finally {
        try { process.kill(-unrelated.pid!, "SIGKILL"); } catch {}
        try { process.kill(-start.childPid, "SIGKILL"); } catch {}
        closeSurface(surface);
      }
    });

    it("honors durable cancellation recorded before the supervisor starts", async () => {
      const surface = createSurface("cancel-before-start");
      const surfaceIdentity = getSurfaceIdentity(surface);
      const identity = createRunControlIdentity("cancel-before-start-run", join(dir, "cancel.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      const command = createSupervisedCommand("sleep 30", runFiles, identity);
      assert.equal(
        await terminateSupervisedRun(runFiles, identity, { startupWaitMs: 0 }),
        "not-started",
      );
      sendLongCommand(surface, command, { scriptPath: join(dir, "cancel-launch.sh") });
      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 20,
        identity,
        runFiles,
        surfaceIdentity,
        completionRequired: true,
      });
      assert.equal(result.reason, "process-exit");
      assert.equal(result.exitCode, 143);
      const start = readProcessStartRecord(runFiles.startFile, identity);
      assert.ok(start);
      assert.equal(start.childPid, null);
      closeSurface(surface);
    });

    it("reports a missing pane as an explicit recoverable failure", async () => {
      const surface = createSurface("missing");
      const surfaceIdentity = getSurfaceIdentity(surface);
      const identity = createRunControlIdentity("missing-run", join(dir, "missing.jsonl"));
      const runFiles = getRunFiles(dir, identity.runId);
      closeSurface(surface);

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 20,
        identity,
        runFiles,
        surfaceIdentity,
      });
      assert.equal(result.reason, "surface-missing");
      assert.match(result.errorMessage ?? "", /may be resumed/);
    });

    it("detects a real respawned pane with stable IDs and changed PID", async () => {
      const surface = createSurface("reused");
      const original = getSurfaceIdentity(surface);
      execFileSync("tmux", ["-S", socket, "respawn-pane", "-k", "-t", surface]);
      const respawned = getSurfaceIdentity(surface);
      assert.equal(respawned.paneId, original.paneId);
      assert.equal(respawned.windowId, original.windowId);
      assert.notEqual(respawned.panePid, original.panePid);

      const identity = createRunControlIdentity("reused-run", join(dir, "reused.jsonl"));
      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 20,
        identity,
        runFiles: getRunFiles(dir, identity.runId),
        surfaceIdentity: original,
      });
      assert.equal(result.reason, "surface-reused");
      assert.match(result.errorMessage ?? "", /refusing to observe or close/);
      closeSurface(surface);
    });
  });
}
