import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import subagentsExtension, {
  SUBAGENT_LIFECYCLE_REQUEST_CHANNEL,
  SUBAGENT_LIFECYCLE_SNAPSHOT_CHANNEL,
  __test__,
} from "../../pi-extension/subagents/index.ts";

const tmuxAvailable = (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
})();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error("tool lifecycle fixture timed out");
}

function readJsonLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const fakePiSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionFile = args[sessionIndex + 1];
const wasResume = fs.existsSync(sessionFile);
const logFile = process.env.FAKE_PI_LOG;
const record = {
  kind: "invocation",
  runId: process.env.PI_SUBAGENT_ID,
  token: process.env.PI_SUBAGENT_CONTROL_TOKEN,
  sessionFile,
  controlSocket: process.env.PI_SUBAGENT_CONTROL_SOCKET,
  wasResume,
  args,
  pid: process.pid,
};
fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (!wasResume) {
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "fixture-session", timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
}
let finished = false;
const socket = net.createConnection(process.env.PI_SUBAGENT_CONTROL_SOCKET);
socket.setEncoding("utf8");
socket.on("error", () => {});
socket.on("connect", () => {
  fs.appendFileSync(logFile, JSON.stringify({ kind: "connected", runId: process.env.PI_SUBAGENT_ID }) + "\n");
  socket.write(JSON.stringify({
    version: 1,
    type: "hello",
    runId: process.env.PI_SUBAGENT_ID,
    token: process.env.PI_SUBAGENT_CONTROL_TOKEN,
    sessionFile,
  }) + "\n");
  if (wasResume) setTimeout(() => finish("resumed result"), 30);
});
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "deliver") continue;
    fs.appendFileSync(logFile, JSON.stringify({ kind: "steer", runId: process.env.PI_SUBAGENT_ID, message: frame.message }) + "\n");
    socket.write(JSON.stringify({ version: 1, type: "ack", requestId: frame.requestId, status: "dispatch-invoked", mode: "steer" }) + "\n");
    setTimeout(() => finish("fresh result"), 30);
  }
});
function finish(text) {
  if (finished) return;
  finished = true;
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", id: Math.random().toString(16), message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n");
  const completion = {
    version: 1,
    kind: "completion",
    runId: process.env.PI_SUBAGENT_ID,
    token: process.env.PI_SUBAGENT_CONTROL_TOKEN,
    sessionFile,
    writtenAt: Date.now(),
    status: "completed",
  };
  fs.mkdirSync(path.dirname(process.env.PI_SUBAGENT_COMPLETION_FILE), { recursive: true });
  fs.writeFileSync(process.env.PI_SUBAGENT_COMPLETION_FILE, JSON.stringify(completion) + "\n");
  socket.write(JSON.stringify({ version: 1, type: "complete", runId: process.env.PI_SUBAGENT_ID }) + "\n", () => {
    socket.end();
    setTimeout(() => process.exit(0), 10);
  });
}
`;

if (!tmuxAvailable) {
  it("requires tmux for the tool lifecycle regression", { skip: true }, () => undefined);
} else {
  describe("model-free registered-tool lifecycle", { concurrency: 1 }, () => {
    let dir: string;
    let socket: string;
    let oldCwd: string;
    let oldTmux: string | undefined;
    let oldPane: string | undefined;
    let oldPath: string | undefined;
    let oldLog: string | undefined;
    let oldAgent: string | undefined;
    let shutdownExtension: (() => Promise<void>) | undefined;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "subagent-tool-lifecycle-"));
      oldCwd = process.cwd();
      process.chdir(dir);
      socket = join(dir, "tmux.sock");
      const fakeBin = join(dir, "bin");
      mkdirSync(fakeBin, { recursive: true });
      symlinkSync(process.execPath, join(fakeBin, "node"));
      writeFileSync(join(fakeBin, "pi"), fakePiSource);
      chmodSync(join(fakeBin, "pi"), 0o755);
      oldTmux = process.env.TMUX;
      oldPane = process.env.TMUX_PANE;
      oldPath = process.env.PATH;
      oldLog = process.env.FAKE_PI_LOG;
      oldAgent = process.env.PI_SUBAGENT_AGENT;
      process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
      process.env.FAKE_PI_LOG = join(dir, "fake-pi.jsonl");
      delete process.env.PI_SUBAGENT_AGENT;

      // Start the isolated server only after installing the inert fixture PATH;
      // every subsequently split pane inherits it without touching live tmux.
      execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", "120", "-y", "40"]);
      const pid = execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { encoding: "utf8" }).trim();
      const anchor = execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pane_id}"], { encoding: "utf8" }).trim();
      const fixtureShell = join(fakeBin, "fixture-shell");
      writeFileSync(
        fixtureShell,
        `#!/bin/bash\nexport PATH=${JSON.stringify(process.env.PATH)}\nexport FAKE_PI_LOG=${JSON.stringify(process.env.FAKE_PI_LOG)}\nexec /bin/bash --noprofile --norc -i\n`,
      );
      chmodSync(fixtureShell, 0o755);
      execFileSync("tmux", ["-S", socket, "set-option", "-g", "default-command", fixtureShell]);
      process.env.TMUX = `${socket},${pid},0`;
      process.env.TMUX_PANE = anchor;
    });

    after(async () => {
      await shutdownExtension?.();
      await delay(200);
      try { execFileSync("tmux", ["-S", socket, "kill-server"]); } catch {}
      if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
      if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldLog === undefined) delete process.env.FAKE_PI_LOG; else process.env.FAKE_PI_LOG = oldLog;
      if (oldAgent === undefined) delete process.env.PI_SUBAGENT_AGENT; else process.env.PI_SUBAGENT_AGENT = oldAgent;
      process.chdir(oldCwd);
      rmSync(dir, { recursive: true, force: true });
    });

    it("recovers stale Node for fresh/resume, rejects unavailable Node, and preserves lifecycle", async () => {
      async function withRemovedParentNode<T>(action: () => Promise<T>): Promise<T> {
        const descriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
        Object.defineProperty(process, "execPath", { ...descriptor, value: join(dir, "removed-node") });
        try { return await action(); }
        finally { Object.defineProperty(process, "execPath", descriptor); }
      }
      const tools = new Map<string, any>();
      const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
      const busHandlers = new Map<string, Array<(data: unknown) => void>>();
      const notifications: any[] = [];
      const lifecycleSnapshots: any[] = [];
      const pi: any = {
        events: {
          emit(channel: string, data: unknown) {
            if (channel === SUBAGENT_LIFECYCLE_SNAPSHOT_CHANNEL) lifecycleSnapshots.push(data);
            for (const handler of busHandlers.get(channel) ?? []) handler(data);
          },
          on(channel: string, handler: (data: unknown) => void) {
            const list = busHandlers.get(channel) ?? [];
            list.push(handler);
            busHandlers.set(channel, list);
            return () => busHandlers.set(channel, list.filter((item) => item !== handler));
          },
        },
        on(name: string, handler: (event: any, ctx: any) => unknown) {
          const list = handlers.get(name) ?? [];
          list.push(handler);
          handlers.set(name, list);
        },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage(message: any, options: any) { notifications.push({ message, options }); },
        sendUserMessage() {},
      };
      subagentsExtension(pi);

      const parentSession = join(dir, "sessions", "parent.jsonl");
      mkdirSync(dirname(parentSession), { recursive: true });
      writeFileSync(parentSession, JSON.stringify({ type: "session", id: "parent-id", cwd: dir }) + "\n");
      const ctx: any = {
        cwd: dir,
        isIdle: () => true,
        ui: { setWidget() {}, notify() {} },
        sessionManager: {
          getSessionFile: () => parentSession,
          getSessionId: () => "parent-id",
          getSessionDir: () => dirname(parentSession),
        },
      };
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
      shutdownExtension = async () => {
        for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      };

      const projectAgentDir = join(process.cwd(), ".pi", "agents");
      const unsupportedProfile = join(projectAgentDir, "differently-named-file.md");
      mkdirSync(projectAgentDir, { recursive: true });
      writeFileSync(unsupportedProfile, "---\nname: scout\ndescription: unsupported fixture\ncli: claude\ntools: read\n---\nfixture\n");
      const panesBeforeUnsupported = execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" });
      try {
        await assert.rejects(
          tools.get("subagent").execute(
            "unsupported-call",
            { agent: "scout", name: "unsupported-fixture", task: "must not launch" },
            new AbortController().signal,
            () => {},
            ctx,
          ),
          /cli: claude.*does not support/,
        );
      } finally {
        rmSync(unsupportedProfile, { force: true });
        try { rmdirSync(projectAgentDir); } catch {}
        try { rmdirSync(join(process.cwd(), ".pi")); } catch {}
      }
      const panesAfterUnsupported = execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" });
      assert.equal(panesAfterUnsupported, panesBeforeUnsupported);
      assert.equal(existsSync(process.env.FAKE_PI_LOG!), false);

      // R3: the selected definition is addressed by declared frontmatter name,
      // not its filename, and its exact sandbox is persisted for resume.
      mkdirSync(projectAgentDir, { recursive: true });
      writeFileSync(
        unsupportedProfile,
        "---\nname: scout\ndescription: selected fixture\nmodel: fixture/provider-model\nthinking: high\ntools: read, edit\nsystem-prompt: append\nauto-exit: true\n---\nDECLARED_ROLE_IDENTITY\n",
      );
      let spawn: any;
      try {
        spawn = await withRemovedParentNode(() => tools.get("subagent").execute(
          "spawn-call",
          { agent: "scout", name: "fixture-scout", task: "initial fixture task" },
          new AbortController().signal,
          () => {},
          ctx,
        ));
        const savedLoadout = JSON.parse(readFileSync(`${spawn.details.sessionFile}.loadout.json`, "utf8"));
        assert.equal(savedLoadout.agent, "scout");
        assert.equal(savedLoadout.model, "fixture/provider-model");
        assert.equal(savedLoadout.thinking, "high");
        assert.equal(savedLoadout.toolAllowlist, "read,edit,ask_question");
        assert.deepEqual(savedLoadout.extensionPaths, []);
        assert.equal(savedLoadout.schemaVersion, 2);
        assert.equal(savedLoadout.systemPromptMode, "append");
        assert.equal(savedLoadout.identity, "DECLARED_ROLE_IDENTITY");
      } finally {
        rmSync(unsupportedProfile, { force: true });
        try { rmdirSync(projectAgentDir); } catch {}
        try { rmdirSync(join(process.cwd(), ".pi")); } catch {}
      }
      assert.equal(spawn.details.status, "started", JSON.stringify(spawn));
      assert.deepEqual(lifecycleSnapshots.at(-1)?.running, [spawn.details.id]);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.pendingDeliveries, []);
      const parentArtifactDir = join(dirname(parentSession), "artifacts", "parent-id");
      const freshTaskFile = join(parentArtifactDir, "context", `subagent-${spawn.details.id}-task.md`);
      const freshIdentityFile = join(parentArtifactDir, "context", `subagent-${spawn.details.id}-identity.md`);
      assert.match(readFileSync(freshTaskFile, "utf8"), /initial fixture task/);
      assert.equal(readFileSync(freshIdentityFile, "utf8"), "DECLARED_ROLE_IDENTITY");
      assert.equal(
        spawn.details.launchScriptFile,
        join(parentArtifactDir, "subagent-scripts", `subagent-${spawn.details.id}.sh`),
      );
      const logFile = process.env.FAKE_PI_LOG!;
      try {
        await waitFor(() => readJsonLines(logFile).some((entry) => entry.kind === "connected"), 3_000);
      } catch {
        const panes = execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}:#{pane_current_command}:#{pane_dead}"], { encoding: "utf8" });
        const screen = execFileSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", ":.+"], { encoding: "utf8" });
        throw new Error(`fake pi did not launch\n${panes}\n${screen}\n${readFileSync(spawn.details.launchScriptFile, "utf8")}`);
      }
      await waitFor(
        () => Boolean((__test__.runningSubagents.get(spawn.details.id)?.controlServer as any)?.socket),
        3_000,
      );

      const exactSteerMessage = "  LIVE_SOCKET_ONLY_MARKER\n    indented code\n";
      const steer = await tools.get("subagent_message").execute(
        "steer-call",
        { name: "fixture-scout", message: exactSteerMessage },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.equal(steer.details.status, "delivery-unknown");
      assert.equal(steer.details.childReceived, true);
      await waitFor(() => notifications.filter((item) => item.message.customType === "subagent_result").length === 1);
      assert.match(notifications[0].message.content, /fresh result/);
      assert.equal(notifications[0].message.details.summary, "fresh result");
      assert.deepEqual(lifecycleSnapshots.at(-1)?.running, []);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.pendingDeliveries, [spawn.details.id]);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.result,
                       { id: spawn.details.id, failed: false });
      for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
      for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.pendingDeliveries, []);

      const launchScript = readFileSync(spawn.details.launchScriptFile, "utf8");
      assert.doesNotMatch(launchScript, /LIVE_SOCKET_ONLY_MARKER/);
      assert.ok(launchScript.includes(`exec '${join(dir, "bin", "node")}' `));
      assert.equal(
        readJsonLines(logFile).find((entry) => entry.kind === "steer")?.message,
        exactSteerMessage,
      );

      // Runtime rejection must unwind the existing fresh/resume transactions,
      // preserve the finished transcript, and never dispatch a payload.
      const rejectedBin = join(dir, "rejected-bin");
      mkdirSync(rejectedBin);
      writeFileSync(join(rejectedBin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const launchPath = process.env.PATH;
      const transcriptBefore = readFileSync(spawn.details.sessionFile, "utf8");
      const invocationsBefore = readJsonLines(logFile).filter((entry) => entry.kind === "invocation").length;
      const runsBefore = readdirSync(join(parentArtifactDir, "subagent-runs"));
      const panesBefore = execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" });
      try {
        process.env.PATH = `${rejectedBin}:${launchPath}`;
        await withRemovedParentNode(async () => {
          await assert.rejects(
            tools.get("subagent").execute(
              "runtime-rejected-fresh", { agent: "scout", name: "runtime-rejected", task: "must not launch" },
              new AbortController().signal, () => {}, ctx,
            ),
            /Cannot launch subagent supervisor.*Node.*PATH/,
          );
          await assert.rejects(
            tools.get("subagent_message").execute(
              "runtime-rejected-resume", { name: "fixture-scout", message: "must not launch" },
              new AbortController().signal, () => {}, ctx,
            ),
            /Cannot launch subagent supervisor.*Node.*PATH/,
          );
        });
      } finally {
        process.env.PATH = launchPath;
      }
      assert.equal(readFileSync(spawn.details.sessionFile, "utf8"), transcriptBefore);
      assert.equal(readJsonLines(logFile).filter((entry) => entry.kind === "invocation").length, invocationsBefore);
      assert.deepEqual(readdirSync(join(parentArtifactDir, "subagent-runs")), runsBefore);
      assert.equal(execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" }), panesBefore);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.running, []);

      const exactResumeMessage = "  resume fixture task\n    indented follow-up\n";
      const resume: any = await withRemovedParentNode(() => tools.get("subagent_message").execute(
        "resume-call",
        { name: "fixture-scout", message: exactResumeMessage },
        new AbortController().signal,
        () => {},
        ctx,
      ));
      assert.equal(resume.details.status, "started");
      assert.deepEqual(lifecycleSnapshots.at(-1)?.running, [resume.details.id]);
      const resumeMessageFile = join(
        parentArtifactDir,
        "subagent-resume",
        `subagent-${resume.details.id}-message.md`,
      );
      const resumeIdentityFile = join(
        parentArtifactDir,
        "context",
        `subagent-${resume.details.id}-identity.md`,
      );
      assert.equal(readFileSync(resumeMessageFile, "utf8"), exactResumeMessage);
      assert.equal(readFileSync(resumeIdentityFile, "utf8"), "DECLARED_ROLE_IDENTITY");
      assert.equal(
        resume.details.launchScriptFile,
        join(parentArtifactDir, "subagent-scripts", `subagent-${resume.details.id}.sh`),
      );
      const resumeLaunchScript = readFileSync(resume.details.launchScriptFile, "utf8");
      assert.ok(resumeLaunchScript.includes(`exec '${join(dir, "bin", "node")}' `));
      assert.match(resumeLaunchScript, new RegExp(resume.details.id));
      assert.match(resumeLaunchScript, /resume fixture task|Resume message file:/);
      await waitFor(() => notifications.filter((item) => item.message.customType === "subagent_result").length === 2);
      assert.match(notifications[1].message.content, /resumed result/);
      assert.equal(notifications[1].message.details.summary, "resumed result");
      assert.deepEqual(lifecycleSnapshots.at(-1)?.running, []);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.pendingDeliveries, [resume.details.id]);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.result,
                       { id: resume.details.id, failed: false });
      for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
      for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);

      // R1: parallel resume calls synchronously reserve the canonical transcript.
      const notificationCount = () =>
        notifications.filter((item) => item.message.customType === "subagent_result").length;
      const concurrentResume = await Promise.all([
        tools.get("subagent_message").execute(
          "parallel-resume-a",
          { name: "fixture-scout", message: "first concurrent resume" },
          new AbortController().signal,
          () => {},
          ctx,
        ),
        tools.get("subagent_message").execute(
          "parallel-resume-b",
          { name: "fixture-scout", message: "second concurrent resume" },
          new AbortController().signal,
          () => {},
          ctx,
        ),
      ]);
      assert.equal(concurrentResume.filter((result) => result.details.status === "started").length, 1);
      const blockedResume = concurrentResume.find((result) => result.details.error);
      assert.match(blockedResume?.details.error ?? "", /resume launch in progress/);
      await waitFor(() => notificationCount() === 3);

      // A failed launch releases its transcript reservation for a later retry.
      const validPane = process.env.TMUX_PANE;
      process.env.TMUX_PANE = "%missing-fixture-pane";
      try {
        await assert.rejects(
          tools.get("subagent_message").execute(
            "failed-resume",
            { name: "fixture-scout", message: "must fail before launch" },
            new AbortController().signal,
            () => {},
            ctx,
          ),
        );
      } finally {
        process.env.TMUX_PANE = validPane;
      }
      const retryResume = await tools.get("subagent_message").execute(
        "retry-resume",
        { name: "fixture-scout", message: "retry after failed launch" },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.equal(retryResume.details.status, "started");
      await waitFor(() => notificationCount() === 4);

      // R4: explicit names follow the same suffix policy for finished and
      // parallel in-flight handles, while every actual handle stays usable.
      const finishedCollision = await tools.get("subagent").execute(
        "finished-name-collision",
        { agent: "scout", name: "fixture-scout", task: "finished handle collision" },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.equal(finishedCollision.details.name, "fixture-scout-2");
      await waitFor(() => readJsonLines(logFile).filter((entry) => entry.kind === "connected").length >= 5);
      await tools.get("subagent_message").execute(
        "finish-suffixed",
        { name: "fixture-scout-2", message: "finish explicit collision" },
        new AbortController().signal,
        () => {},
        ctx,
      );
      await waitFor(() => notificationCount() === 5);

      const parallelNames = await Promise.all([
        tools.get("subagent").execute(
          "parallel-name-a",
          { agent: "scout", name: "parallel-name", task: "parallel name one" },
          new AbortController().signal,
          () => {},
          ctx,
        ),
        tools.get("subagent").execute(
          "parallel-name-b",
          { agent: "scout", name: "parallel-name", task: "parallel name two" },
          new AbortController().signal,
          () => {},
          ctx,
        ),
      ]);
      assert.deepEqual(
        new Set(parallelNames.map((result) => result.details.name)),
        new Set(["parallel-name", "parallel-name-2"]),
      );
      await waitFor(() => readJsonLines(logFile).filter((entry) => entry.kind === "connected").length >= 7);
      for (const result of parallelNames) {
        await tools.get("subagent_message").execute(
          `finish-${result.details.name}`,
          { name: result.details.name, message: `finish ${result.details.name}` },
          new AbortController().signal,
          () => {},
          ctx,
        );
      }
      await waitFor(() => notificationCount() === 7);

      // R5: names that sanitize identically still receive run-unique task paths.
      const collidingArtifacts = await Promise.all([
        tools.get("subagent").execute(
          "artifact-a",
          { agent: "scout", name: "a_b", task: "TASK_CONTENT_UNDERSCORE" },
          new AbortController().signal,
          () => {},
          ctx,
        ),
        tools.get("subagent").execute(
          "artifact-b",
          { agent: "scout", name: "ab", task: "TASK_CONTENT_PLAIN" },
          new AbortController().signal,
          () => {},
          ctx,
        ),
      ]);
      await waitFor(() => readJsonLines(logFile).filter((entry) => entry.kind === "connected").length >= 9);
      const artifactInvocations = readJsonLines(logFile)
        .filter((entry) => entry.kind === "invocation")
        .filter((entry) => collidingArtifacts.some((result) => result.details.id === entry.runId));
      const taskFiles = artifactInvocations.map((entry) =>
        entry.args.find((arg: string) => arg.startsWith("@") && arg.endsWith("-task.md"))?.slice(1),
      );
      assert.equal(taskFiles.length, 2);
      assert.ok(taskFiles.every((path) => typeof path === "string"));
      assert.notEqual(taskFiles[0], taskFiles[1]);
      assert.match(readFileSync(taskFiles[0], "utf8"), /TASK_CONTENT_(UNDERSCORE|PLAIN)/);
      assert.match(readFileSync(taskFiles[1], "utf8"), /TASK_CONTENT_(UNDERSCORE|PLAIN)/);
      assert.notEqual(readFileSync(taskFiles[0], "utf8"), readFileSync(taskFiles[1], "utf8"));
      for (const result of collidingArtifacts) {
        await tools.get("subagent_message").execute(
          `finish-${result.details.name}`,
          { name: result.details.name, message: `finish ${result.details.name}` },
          new AbortController().signal,
          () => {},
          ctx,
        );
      }
      await waitFor(() => notificationCount() === 9);

      // R5: rollback after task/identity/script allocation is scoped to the
      // failed run and cannot remove a neighboring launch's artifacts.
      const neighboringTaskFile = taskFiles[0];
      const neighboringTaskContent = readFileSync(neighboringTaskFile, "utf8");
      const panesBeforeRollback = new Set(
        execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean),
      );
      const failedArtifactLaunch = tools.get("subagent").execute(
        "failed-artifact-launch",
        { agent: "scout", name: "rollback-artifact", task: "ROLLBACK_ONLY_TASK_MARKER" },
        new AbortController().signal,
        () => {},
        ctx,
      );
      let rollbackPane = "";
      await waitFor(() => {
        const panes = execFileSync(
          "tmux",
          ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"],
          { encoding: "utf8" },
        ).trim().split("\n").filter(Boolean);
        rollbackPane = panes.find((pane) => !panesBeforeRollback.has(pane)) ?? "";
        return rollbackPane !== "";
      });
      execFileSync("tmux", ["-S", socket, "kill-pane", "-t", rollbackPane]);
      await assert.rejects(failedArtifactLaunch);
      assert.equal(readFileSync(neighboringTaskFile, "utf8"), neighboringTaskContent);
      const contextFilesAfterRollback = readdirSync(join(parentArtifactDir, "context"));
      for (const file of contextFilesAfterRollback) {
        assert.doesNotMatch(
          readFileSync(join(parentArtifactDir, "context", file), "utf8"),
          /ROLLBACK_ONLY_TASK_MARKER/,
        );
      }

      // Failed explicit-name launches release the in-flight name reservation.
      const retryPane = process.env.TMUX_PANE;
      process.env.TMUX_PANE = "%missing-name-fixture-pane";
      try {
        await assert.rejects(
          tools.get("subagent").execute(
            "failed-explicit-name",
            { agent: "scout", name: "retry-name", task: "must fail" },
            new AbortController().signal,
            () => {},
            ctx,
          ),
        );
      } finally {
        process.env.TMUX_PANE = retryPane;
      }
      const retriedName = await tools.get("subagent").execute(
        "retried-explicit-name",
        { agent: "scout", name: "retry-name", task: "must keep unsuffixed name" },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.equal(retriedName.details.name, "retry-name");
      await waitFor(() => readJsonLines(logFile).filter((entry) => entry.kind === "connected").length >= 10);
      await tools.get("subagent_message").execute(
        "finish-retried-name",
        { name: "retry-name", message: "finish retry-name" },
        new AbortController().signal,
        () => {},
        ctx,
      );
      await waitFor(() => notificationCount() === 10);

      // R15 round 2: actual discovered profiles with omitted or blank tools
      // stay control-only even when the following metadata names mutating and
      // spawning tools. Fresh and resumed command arguments must match.
      mkdirSync(projectAgentDir, { recursive: true });
      const noToolVariants = [
        { name: "omitted", toolsLine: "" },
        { name: "empty", toolsLine: "tools:\n" },
        { name: "whitespace", toolsLine: "tools:   \n" },
      ];
      try {
        for (const variant of noToolVariants) {
          const agentName = "scout";
          const displayName = `no-tools-${variant.name}`;
          const profile = join(projectAgentDir, `${displayName}.md`);
          writeFileSync(
            profile,
            `---\nname: ${agentName}\n${variant.toolsLine}` +
              "description: Can discuss read, write, edit, bash, subagent, subagent_message\n" +
              "auto-exit: true\n---\nControl-only fixture.\n",
          );

          const beforeResults = notificationCount();
          const fresh = await tools.get("subagent").execute(
            `no-tools-fresh-${variant.name}`,
            { agent: agentName, name: displayName, task: `fresh ${variant.name}` },
            new AbortController().signal,
            () => {},
            ctx,
          );
          assert.equal(fresh.details.status, "started", JSON.stringify(fresh));
          const savedLoadout = JSON.parse(
            readFileSync(`${fresh.details.sessionFile}.loadout.json`, "utf8"),
          );
          assert.equal(savedLoadout.toolAllowlist, "ask_question");
          assert.deepEqual(savedLoadout.extensionPaths, []);
          await waitFor(
            () => Boolean((__test__.runningSubagents.get(fresh.details.id)?.controlServer as any)?.socket),
            3_000,
          );
          const freshInvocation = readJsonLines(logFile).find(
            (entry) => entry.kind === "invocation" && entry.runId === fresh.details.id,
          );
          assert.ok(freshInvocation.args.includes("--no-extensions"));
          assert.equal(freshInvocation.args[freshInvocation.args.indexOf("--tools") + 1], "ask_question");

          const delivery = await tools.get("subagent_message").execute(
            `no-tools-finish-${variant.name}`,
            { name: displayName, message: `finish ${variant.name}` },
            new AbortController().signal,
            () => {},
            ctx,
          );
          assert.equal(delivery.details.status, "delivery-unknown");
          await waitFor(() => notificationCount() === beforeResults + 1);

          const resumed = await tools.get("subagent_message").execute(
            `no-tools-resume-${variant.name}`,
            { name: displayName, message: `resume ${variant.name}` },
            new AbortController().signal,
            () => {},
            ctx,
          );
          assert.equal(resumed.details.status, "started");
          await waitFor(() => notificationCount() === beforeResults + 2);
          const resumeInvocation = readJsonLines(logFile).find(
            (entry) => entry.kind === "invocation" && entry.runId === resumed.details.id,
          );
          assert.ok(resumeInvocation.args.includes("--no-extensions"));
          assert.equal(resumeInvocation.args[resumeInvocation.args.indexOf("--tools") + 1], "ask_question");
          rmSync(profile, { force: true });
        }
      } finally {
        rmSync(projectAgentDir, { recursive: true, force: true });
        try { rmdirSync(join(process.cwd(), ".pi")); } catch {}
      }

      const invocations = readJsonLines(logFile).filter((entry) => entry.kind === "invocation");
      assert.notEqual(invocations[0].runId, invocations[1].runId);
      assert.notEqual(invocations[0].token, invocations[1].token);
      assert.equal(invocations[0].sessionFile, invocations[1].sessionFile);
      assert.equal(invocations[0].wasResume, false);
      assert.equal(invocations[1].wasResume, true);
      for (const invocation of invocations) {
        assert.ok(invocation.args.includes("--no-extensions"));
        assert.ok(invocation.args.includes("--tools"));
      }
      assert.ok(
        readJsonLines(logFile).filter((entry) => entry.kind === "steer").some((entry) =>
          entry.message === exactSteerMessage),
      );
      assert.equal(notificationCount(), 16);

      const inFlight = await tools.get("subagent").execute(
        "shutdown-call",
        { agent: "scout", name: "shutdown-fixture", task: "wait for parent shutdown" },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.equal(inFlight.details.status, "started");
      await waitFor(
        () => readJsonLines(logFile).filter((entry) => entry.kind === "connected").length === invocations.length + 1,
      );
      const allInvocations = readJsonLines(logFile).filter((entry) => entry.kind === "invocation");

      const notificationsBeforeShutdown = notificationCount();
      await shutdownExtension();
      await delay(100);
      assert.equal(notificationCount(), notificationsBeforeShutdown);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.running, []);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.pendingDeliveries, []);
      assert.equal(lifecycleSnapshots.at(-1)?.result, undefined);

      const snapshotsBeforeInterSessionRequest = lifecycleSnapshots.length;
      pi.events.emit(SUBAGENT_LIFECYCLE_REQUEST_CHANNEL, undefined);
      assert.equal(lifecycleSnapshots.length, snapshotsBeforeInterSessionRequest + 1);
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
      const snapshotsBeforeSecondSessionRequest = lifecycleSnapshots.length;
      pi.events.emit(SUBAGENT_LIFECYCLE_REQUEST_CHANNEL, undefined);
      assert.equal(lifecycleSnapshots.length, snapshotsBeforeSecondSessionRequest + 1);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.running, []);
      assert.deepEqual(lifecycleSnapshots.at(-1)?.pendingDeliveries, []);

      await shutdownExtension();
      shutdownExtension = undefined;
      const paneCount = Number(execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length);
      assert.equal(paneCount, 1);
      for (const invocation of allInvocations) {
        assert.equal(existsSync(invocation.controlSocket), false);
        assert.throws(
          () => process.kill(invocation.pid, 0),
          (error: any) => error?.code === "ESRCH",
        );
      }
      const runDirs = readdirSync(join(dirname(parentSession), "artifacts", "parent-id", "subagent-runs"));
      assert.equal(runDirs.length, allInvocations.length);
    });
  });
}
