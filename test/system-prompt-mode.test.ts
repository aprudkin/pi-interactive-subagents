import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAllowed = process.env.PI_SUBAGENT_ALLOWED;
const root = mkdtempSync(join(tmpdir(), "subagent-system-prompt-"));
const agentDir = join(root, "agent-dir");
const projectDir = join(root, "project");

before(() => {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
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

function writeAgent(filename: string, frontmatter: string[], body = ""): void {
  writeFileSync(
    join(agentDir, "agents", filename),
    ["---", ...frontmatter, "---", body, ""].join("\n"),
  );
}

describe("production system-prompt routing", { concurrency: 1 }, () => {
  it("routes replace identity from discovery through fresh preparation and sandbox flags", async () => {
    writeAgent(
      "replace-fixture.md",
      ["name: replace-fixture", "tools: read", "system-prompt: replace", "auto-exit: true"],
      "You are a replacement identity.",
    );

    const { __test__ } = await import("../pi-extension/subagents/index.ts");
    const definition = __test__.discoverAgentDefinitions().find((item) => item.name === "replace-fixture");
    assert.ok(definition);

    const prepared = __test__.prepareAgentLaunchProfile(
      { agent: "replace-fixture", task: "Perform the fixture task" },
      definition,
    );
    assert.equal(prepared.loadout.systemPromptMode, "replace");
    assert.equal(prepared.loadout.identity, "You are a replacement identity.");
    assert.doesNotMatch(prepared.fullTask, /replacement identity/);
    assert.match(prepared.fullTask, /Perform the fixture task/);

    const identityDir = join(root, "replace-artifacts");
    const parts: string[] = [];
    __test__.applySandboxToParts(parts, {
      schemaVersion: 2,
      runtime: "pi",
      agent: "replace-fixture",
      ...prepared.loadout,
      cwd: null,
      agentDir,
    }, { artifactDir: identityDir, runId: "replace" });
    const flagIndex = parts.indexOf("--system-prompt");
    assert.notEqual(flagIndex, -1);
    assert.equal(parts.includes("--append-system-prompt"), false);
    const identityPath = parts[flagIndex + 1].slice(1, -1);
    assert.equal(existsSync(identityPath), true);
    assert.equal(readFileSync(identityPath, "utf8"), "You are a replacement identity.");
  });

  it("keeps default and invalid modes in the task instead of selecting a prompt flag", async () => {
    writeAgent(
      "default-fixture.md",
      ["name: default-fixture", "tools: read", "auto-exit: true"],
      "You are a default identity.",
    );
    writeAgent(
      "invalid-fixture.md",
      ["name: invalid-fixture", "tools: read", "system-prompt: foobar", "auto-exit: true"],
      "You are an invalid-mode identity.",
    );

    const { __test__ } = await import("../pi-extension/subagents/index.ts");
    const definitions = __test__.discoverAgentDefinitions();
    for (const [name, identity] of [
      ["default-fixture", "You are a default identity."],
      ["invalid-fixture", "You are an invalid-mode identity."],
    ] as const) {
      const definition = definitions.find((item) => item.name === name);
      assert.ok(definition);
      const prepared = __test__.prepareAgentLaunchProfile(
        { agent: name, task: "Perform the fixture task" },
        definition,
      );
      assert.equal(prepared.loadout.systemPromptMode, null);
      assert.equal(prepared.loadout.identity, null);
      assert.match(prepared.fullTask, new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const parts: string[] = [];
      __test__.applySandboxToParts(parts, {
        schemaVersion: 2,
        runtime: "pi",
        agent: name,
        ...prepared.loadout,
        cwd: null,
        agentDir,
      }, { artifactDir: join(root, `${name}-artifacts`), runId: name });
      assert.equal(parts.includes("--system-prompt"), false);
      assert.equal(parts.includes("--append-system-prompt"), false);
    }
  });

  it("does not emit a prompt flag when a valid mode has no identity body", async () => {
    writeAgent(
      "missing-identity.md",
      ["name: missing-identity", "tools: read", "system-prompt: replace", "auto-exit: true"],
    );

    const { __test__ } = await import("../pi-extension/subagents/index.ts");
    const definition = __test__.discoverAgentDefinitions().find((item) => item.name === "missing-identity");
    assert.ok(definition);
    const prepared = __test__.prepareAgentLaunchProfile(
      { agent: "missing-identity", task: "Perform the fixture task" },
      definition,
    );
    assert.equal(prepared.loadout.systemPromptMode, "replace");
    assert.equal(prepared.loadout.identity, null);
    assert.match(prepared.fullTask, /Perform the fixture task/);

    const parts: string[] = [];
    __test__.applySandboxToParts(parts, {
      schemaVersion: 2,
      runtime: "pi",
      agent: "missing-identity",
      ...prepared.loadout,
      cwd: null,
      agentDir,
    }, { artifactDir: join(root, "missing-artifacts"), runId: "missing" });
    assert.equal(parts.includes("--system-prompt"), false);
    assert.equal(parts.includes("--append-system-prompt"), false);
  });
});
