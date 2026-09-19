import { it, mock } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("ownership fixture timed out");
    await delay(25);
  }
}

// No Pi/model is invoked. The private server inherits this executable before it
// starts, and every child shell bypasses user startup files.
const fakePi = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf('--session') + 1];
const prior = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '';
const mode = fs.readFileSync(process.env.OWNERSHIP_MODE, 'utf8');
const record = { id: process.env.PI_SUBAGENT_ID, pid: process.pid, prior, args,
  cwd: process.cwd(), autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
  allowed: process.env.PI_SUBAGENT_ALLOWED, agentDir: process.env.PI_CODING_AGENT_DIR };
fs.appendFileSync(process.env.OWNERSHIP_LOG, JSON.stringify(record) + '\n');
if (mode === 'hold') { setInterval(() => {}, 1000); }
else {
  if (!prior) fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'fresh-id' }) + '\n');
  if (mode !== 'no-output') fs.appendFileSync(sessionFile, JSON.stringify({ type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'CURRENT_RESULT' }] } }) + '\n');
  fs.writeFileSync(process.env.PI_SUBAGENT_COMPLETION_FILE, JSON.stringify({ version: 1,
    kind: 'completion', runId: process.env.PI_SUBAGENT_ID, token: process.env.PI_SUBAGENT_CONTROL_TOKEN,
    sessionFile, writtenAt: Date.now(), status: 'completed' }));
}
`;

it("fresh/resume share rollback checkpoints and completion ownership", { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "run-ownership-"));
  const socket = join(dir, "tmux.sock");
  const bin = join(dir, "bin");
  const envBefore = { ...process.env };
  const realExec = cp.execFileSync;
  const realWrite = fs.writeFileSync;
  const tmux = (...args: string[]) => realExec("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const notifications: any[] = [];
  let throwOnDelivery = false;
  let shutdown: (() => Promise<void>) | undefined;
  const servers: Array<{ socketPath: string; close(): Promise<void> }> = [];
  const agentDir = join(dir, "agent-config");
  const profile = join(agentDir, "agents", "ownership-fixture.md");
  try {
    fs.mkdirSync(bin);
    fs.mkdirSync(dirname(profile), { recursive: true });
    fs.symlinkSync(process.execPath, join(bin, "node"));
    fs.writeFileSync(join(bin, "pi"), fakePi, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.OWNERSHIP_MODE = join(dir, "mode");
    process.env.OWNERSHIP_LOG = join(dir, "invocations.jsonl");
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
    }
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const [extensionModule, controlModule, sessionModule] = await Promise.all([
      import("../../pi-extension/subagents/index.ts"),
      import("../../pi-extension/subagents/control.ts"),
      import("../../pi-extension/subagents/session.ts"),
    ]);
    const { default: subagentsExtension, __test__ } = extensionModule;
    const { ParentRunControlServer } = controlModule;
    const { registerName, writeSubagentLoadout } = sessionModule;

    fs.writeFileSync(process.env.OWNERSHIP_MODE, "hold");
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", "120", "-y", "40");
    const anchor = tmux("display-message", "-p", "#{pane_id}");
    process.env.TMUX = `${socket},${tmux("display-message", "-p", "#{pid}")},0`;
    process.env.TMUX_PANE = anchor;
    const shell = join(bin, "fixture-shell");
    fs.writeFileSync(shell, `#!/bin/bash\nexport PATH=${JSON.stringify(process.env.PATH)}\nexec /bin/bash --noprofile --norc -i\n`, { mode: 0o755 });
    tmux("set-option", "-g", "default-command", shell);

    subagentsExtension({
      events: { emit() {}, on() { return () => {}; } },
      on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {}, registerMessageRenderer() {},
      sendMessage(message: any) {
        notifications.push(message);
        if (throwOnDelivery) throw new Error("uncertain parent delivery");
      },
    } as any);
    const parent = join(dir, "sessions", "parent.jsonl");
    fs.mkdirSync(dirname(parent));
    fs.writeFileSync(parent, [
      { type: "session", version: 3, id: "parent", cwd: dir },
      { type: "message", id: "parent-turn", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "OLD_PARENT_OUTPUT" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const ctx = { cwd: dir, isIdle: () => true, ui: { setWidget() {}, notify() {} }, sessionManager: {
      getSessionFile: () => parent, getSessionId: () => "parent", getSessionDir: () => dirname(parent),
    } };
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    shutdown = async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); };
    const artifactDir = join(dirname(parent), "artifacts", "parent");
    const existingSession = join(dir, "existing.jsonl");
    const originalSession = JSON.stringify({ type: "session", id: "existing-id" }) + "\n" +
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "OLD_RESUME_OUTPUT" }] } }) + "\n";
    fs.writeFileSync(existingSession, originalSession);
    writeSubagentLoadout(existingSession, {
      schemaVersion: 2, runtime: "pi", agent: "ownership-fixture", toolAllowlist: "read,ask_question",
      extensionPaths: [], model: "fixture/model", thinking: "high", systemPromptMode: "append", identity: "OWNERSHIP_IDENTITY",
      spawnable: ["scout"], autoExit: false, cwd: dir, agentDir,
    });
    const originalLoadout = fs.readFileSync(`${existingSession}.loadout.json`, "utf8");
    registerName(artifactDir, "existing", { sessionFile: existingSession, sessionId: "existing-id" });
    const setProfile = (mode: string) => fs.writeFileSync(profile,
      `---\nname: ownership-fixture\ndescription: isolated fixture\ntools: read\nmodel: fixture/model\nthinking: high\nsystem-prompt: append\nsession-mode: ${mode}\nauto-exit: false\n---\nOWNERSHIP_IDENTITY\n`);
    setProfile("fork");
    const execute = (kind: "fresh" | "resume", name = "fault-run") => tools.get(kind === "fresh" ? "subagent" : "subagent_message").execute(
      "ownership-call", kind === "fresh"
        ? { agent: "ownership-fixture", name, task: "FRESH_TASK", cwd: dir }
        : { name: "existing", message: "RESUME_TASK" },
      new AbortController().signal, () => {}, ctx,
    );
    const files = (root: string): string[] => !fs.existsSync(root) ? [] : fs.readdirSync(root, { recursive: true })
      .map(String).filter((file) => fs.statSync(join(root, file)).isFile()).sort();
    const invocations = () => fs.existsSync(process.env.OWNERSHIP_LOG!)
      ? fs.readFileSync(process.env.OWNERSHIP_LOG!, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const assertProcessGone = async (pid: number) => until(() => {
      try { process.kill(pid, 0); return false; } catch (err: any) { return err.code === "ESRCH"; }
    });

    // Capture the real sockets; faults are injected at actual dependencies,
    // not at a separate test-only launch implementation.
    const realStart = ParentRunControlServer.prototype.start;
    for (const kind of ["fresh", "resume"] as const) {
      for (const checkpoint of ["socket", "pane", "identity", "dispatch"] as const) {
        const beforeFiles = files(artifactDir);
        const beforeSessions = files(join(agentDir, "sessions"));
        const beforeInvocations = invocations().length;
        let fired = false;
        let dispatchedRun: any;
        mock.method(ParentRunControlServer.prototype, "start", async function(this: InstanceType<typeof ParentRunControlServer>) {
          await realStart.call(this);
          servers.push(this);
          if (checkpoint === "socket") { fired = true; throw new Error("injected socket"); }
        });
        mock.method(cp, "execFileSync", ((command: string, args: string[], ...rest: any[]) => {
          if (checkpoint === "pane" && !fired && command === "tmux" && args.includes("#{pane_id}\t#{pane_pid}\t#{window_id}")) {
            fired = true;
            throw new Error("injected pane");
          }
          return (realExec as any)(command, args, ...rest);
        }) as any);
        mock.method(fs, "writeFileSync", ((path: any, ...args: any[]) => {
          const result = (realWrite as any)(path, ...args);
          if (checkpoint === "identity" && String(path).endsWith("-identity.md")) {
            fired = true;
            throw new Error("injected identity");
          }
          return result;
        }) as any);
        const realSet = __test__.runningSubagents.set;
        mock.method(__test__.runningSubagents, "set", function(
          this: typeof __test__.runningSubagents,
          id: string,
          running: Parameters<typeof realSet>[1],
        ) {
          const result = realSet.call(this, id, running);
          if (checkpoint === "dispatch") {
            // Wait synchronously only in this isolated fault fixture: the real
            // supervisor/payload run independently. Rollback must stop an
            // actually dispatched child, not merely remove a script file.
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline && invocations().length === beforeInvocations) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
            assert.equal(invocations().length, beforeInvocations + 1);
            dispatchedRun = JSON.parse(fs.readFileSync(running.runFiles.startFile, "utf8"));
            fired = true;
            throw new Error("injected dispatch");
          }
          return result;
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(execute(kind), new RegExp(`injected ${checkpoint}`));
        } finally {
          mock.restoreAll();
          syncBuiltinESMExports();
        }
        assert.equal(fired, true, `${kind}/${checkpoint} reached`);
        assert.equal(tmux("list-panes", "-a", "-F", "#{pane_id}"), anchor);
        assert.equal(__test__.runningSubagents.size, 0);
        assert.equal(__test__.reservedNames.size, 0);
        assert.equal(__test__.reservedSessionPaths.size, 0);
        assert.deepEqual(files(artifactDir), beforeFiles);
        assert.deepEqual(files(join(agentDir, "sessions")), beforeSessions);
        assert.equal(fs.readFileSync(existingSession, "utf8"), originalSession);
        assert.equal(fs.readFileSync(`${existingSession}.loadout.json`, "utf8"), originalLoadout);
        assert.equal(notifications.length, 0);
        for (const server of servers) assert.equal(fs.existsSync(server.socketPath), false);
        if (dispatchedRun) {
          await assertProcessGone(dispatchedRun.supervisorPid);
          await assertProcessGone(dispatchedRun.childPid);
          await assertProcessGone(invocations().at(-1).pid);
        }
      }
    }

    fs.writeFileSync(process.env.OWNERSHIP_MODE!, "result");
    for (const mode of ["standalone", "lineage-only", "fork"]) {
      setProfile(mode);
      const before = notifications.length;
      const fresh = await execute("fresh", `seed-${mode}`);
      assert.equal(fresh.details.status, "started");
      await until(() => notifications.length === before + 1);
      assert.equal(notifications.at(-1).details.summary, "CURRENT_RESULT");
      const invocation = invocations().find((entry) => entry.id === fresh.details.id);
      if (mode === "standalone") assert.equal(invocation.prior, "");
      else {
        assert.equal(JSON.parse(invocation.prior.split("\n")[0]).parentSession, parent);
        assert.equal(invocation.prior.includes("OLD_PARENT_OUTPUT"), mode === "fork");
      }
      assert.equal(invocation.autoExit, undefined);
      assert.equal(invocation.allowed, undefined);
      assert.equal(invocation.agentDir, agentDir);
      assert.equal(__test__.runningSubagents.size, 0);
    }

    // Original interactive loadout must resume autonomously, with the sandbox
    // replayed and no fallback to old output when the child writes none.
    for (const mode of ["result", "no-output"]) {
      fs.writeFileSync(process.env.OWNERSHIP_MODE!, mode);
      const before = notifications.length;
      const resumed = await execute("resume");
      await until(() => notifications.length === before + 1);
      const result = notifications.at(-1);
      assert.equal(result.details.summary, mode === "result" ? "CURRENT_RESULT" : "Resumed session exited without new output");
      assert.equal(result.details.sessionId, "existing-id");
      const invocation = invocations().find((entry) => entry.id === resumed.details.id);
      assert.equal(invocation.autoExit, "1");
      assert.equal(invocation.allowed, "scout");
      assert.equal(fs.realpathSync(invocation.cwd), fs.realpathSync(dir));
      assert.equal(invocation.agentDir, agentDir);
      assert.ok(invocation.args.includes("--no-extensions"));
      assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "read,ask_question");
      assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "fixture/model:high");
      assert.equal(fs.readFileSync(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], "utf8"), "OWNERSHIP_IDENTITY");
      assert.equal(fs.readFileSync(`${existingSession}.loadout.json`, "utf8"), originalLoadout);
    }

    // If the parent send throws after being invoked, neither entry point may
    // publish a second completion. This is not proof of Pi queue acceptance.
    throwOnDelivery = true;
    for (const kind of ["fresh", "resume"] as const) {
      const before = notifications.length;
      await execute(kind, "uncertain-send");
      await until(() => notifications.length > before);
      await delay(100);
      assert.equal(notifications.length, before + 1);
      assert.equal(__test__.runningSubagents.size, 0);
    }
    await delay(1_100);
    assert.equal(notifications.length, 7);
    assert.equal(tmux("list-panes", "-a", "-F", "#{pane_id}"), anchor);
    for (const invocation of invocations()) await assertProcessGone(invocation.pid);
  } finally {
    try {
      mock.restoreAll();
      syncBuiltinESMExports();
      await shutdown?.();
      for (const server of servers) await server.close();
      try { tmux("kill-server"); } catch {}
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
      Object.assign(process.env, envBefore);
      fs.rmSync(profile, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
