import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAllowed = process.env.PI_SUBAGENT_ALLOWED;
const root = mkdtempSync(join(tmpdir(), "subagent-profile-routing-"));
const agentDir = join(root, "agent-dir");
const projectDir = join(root, "project");

function writeAgent(name: string, fields: string[], body = "fixture"): void {
  writeFileSync(
    join(agentDir, "agents", `${name}.md`),
    ["---", `name: ${name}`, `description: ${name} fixture`, ...fields, "---", body, ""].join("\n"),
  );
}

before(() => {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeAgent("ungranted", ["tools: read,subagent", "auto-exit: true"]);
  writeAgent("blank-grant", ["tools: subagent_message", "subagent_agents:   ", "auto-exit: true"]);
  writeAgent("granted", [
    "tools: read,subagent",
    "subagent_agents: target, target-two",
    "auto-exit: true",
  ]);
  writeAgent("target", ["tools: read", "auto-exit: true"]);
  writeAgent("target-two", ["tools: read", "auto-exit: true"]);
  writeAgent("forbidden", ["tools: read", "auto-exit: true"]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_ALLOWED;
  process.chdir(projectDir);
});

after(() => {
  process.chdir(originalCwd);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalAllowed === undefined) delete process.env.PI_SUBAGENT_ALLOWED;
  else process.env.PI_SUBAGENT_ALLOWED = originalAllowed;
  rmSync(root, { recursive: true, force: true });
});

function registerTools(extension: (pi: any) => void): Map<string, any> {
  const tools = new Map<string, any>();
  extension({
    events: { emit() {}, on() { return () => {}; } },
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
  });
  return tools;
}

describe("explicit spawning grants", { concurrency: 1 }, () => {
  it("rejects omitted and blank target grants before launch resource access", async () => {
    const module = await import("../pi-extension/subagents/index.ts");
    const tools = registerTools(module.default);
    let sessionAccesses = 0;
    const ctx = {
      cwd: projectDir,
      sessionManager: {
        getSessionFile() { sessionAccesses++; throw new Error("session accessed"); },
        getSessionId() { sessionAccesses++; throw new Error("session accessed"); },
        getSessionDir() { sessionAccesses++; throw new Error("session accessed"); },
      },
    };

    for (const agent of ["ungranted", "blank-grant"]) {
      await assert.rejects(
        tools.get("subagent").execute(
          `call-${agent}`,
          { agent, task: "must not launch" },
          new AbortController().signal,
          () => {},
          ctx,
        ),
        new RegExp(`Agent "${agent}".*non-empty subagent_agents target grant`),
      );
    }
    assert.equal(sessionAccesses, 0);
    assert.throws(
      () => module.__test__.buildSubagentToolAllowlist("read,subagent"),
      /non-empty subagent_agents target grant/,
    );
  });

  it("pins granted targets and round-trips the accepted fresh sandbox for resume", async () => {
    const module = await import("../pi-extension/subagents/index.ts");
    const session = await import("../pi-extension/subagents/session.ts");
    const definition = module.__test__.discoverAgentDefinitions().find((item) => item.name === "granted");
    assert.ok(definition);

    const prepared = module.__test__.prepareAgentLaunchProfile(
      { agent: "granted", task: "fixture task" },
      definition,
    );
    assert.deepEqual(prepared.loadout.spawnable, ["target", "target-two"]);
    assert.equal(prepared.loadout.spawnable.includes("forbidden"), false);
    assert.deepEqual(
      prepared.loadout.toolAllowlist.split(","),
      ["read", "subagent", "subagent_message", "subagents_list", "ask_question"],
    );
    assert.equal(prepared.loadout.extensionPaths.length, 1);
    assert.match(prepared.loadout.extensionPaths[0], /pi-extension\/subagents\/index\.ts$/);

    const sessionFile = join(root, "granted.jsonl");
    const loadout = {
      schemaVersion: 2 as const,
      runtime: "pi" as const,
      agent: "granted",
      ...prepared.loadout,
      cwd: null,
      agentDir,
    };
    session.writeSubagentLoadout(sessionFile, loadout);
    const restored = session.readSubagentLoadout(sessionFile);
    assert.deepEqual(restored, loadout);

    for (const [runId, candidate] of [["fresh", loadout], ["resume", restored!]] as const) {
      const parts: string[] = [];
      module.__test__.applySandboxToParts(parts, candidate, { artifactDir: root, runId });
      assert.ok(parts.includes("--no-extensions"));
      assert.equal(parts[parts.indexOf("--tools") + 1], `'${loadout.toolAllowlist}'`);
      assert.ok(parts.includes("-e"));
    }
  });
});

describe("subagent message whitespace", { concurrency: 1 }, () => {
  it("validates with trim but delivers running messages byte-for-byte", async () => {
    const module = await import("../pi-extension/subagents/index.ts");
    const status = await import("../pi-extension/subagents/status.ts");
    const delivered: string[] = [];
    const now = Date.now();
    module.__test__.runningSubagents.set("whitespace-run", {
      id: "whitespace-run",
      name: "runner",
      startTime: now,
      statusState: status.createStatusState({ source: "pi", startTimeMs: now }),
      controlServer: {
        async deliver(message: string) {
          delivered.push(message);
          return {
            status: "delivery-unknown" as const,
            childReceived: true,
            dispatchInvoked: false,
            reason: "fixture-no-dispatch",
          };
        },
      },
    } as any);

    try {
      const exactMessage = "  first line\n    indented code\nlast line \n";
      const result = await module.__test__.handleSubagentSteer({
        name: "runner",
        message: exactMessage,
      });
      assert.deepEqual(delivered, [exactMessage]);
      assert.equal(result.details.status, "delivery-unknown");

      const blank = await module.__test__.handleSubagentSteer({ name: "runner", message: " \n\t " });
      assert.match(blank.details.error ?? "", /message.*required/);
      assert.deepEqual(delivered, [exactMessage]);
    } finally {
      module.__test__.runningSubagents.clear();
    }
  });

  it("rejects blank-only tool messages before either steer or resume routing", async () => {
    const module = await import("../pi-extension/subagents/index.ts");
    const tools = registerTools(module.default);
    const result = await tools.get("subagent_message").execute(
      "blank-message",
      { name: "runner", message: " \n\t " },
      new AbortController().signal,
      () => {},
      {} as any,
    );
    assert.match(result.details.error, /steer or resume/);
  });
});
