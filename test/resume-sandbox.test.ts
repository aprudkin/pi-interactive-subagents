import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __test__,
  registerToolExtension,
} from "../pi-extension/subagents/index.ts";
import {
  readSubagentLoadout,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";
import { createRunControlIdentity } from "../pi-extension/subagents/control.ts";
import { getRunFiles } from "../pi-extension/subagents/run-state.ts";

describe("sandboxed resume", () => {
  it("replays the persisted tool, model, and identity restrictions", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-resume-sandbox-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      const loadout: SubagentLoadout = {
        schemaVersion: 2,
        runtime: "pi",
        agent: "worker",
        toolAllowlist: "read,write,ask_question",
        extensionPaths: [],
        model: "provider/test-model",
        thinking: "high",
        systemPromptMode: "append",
        identity: "You are the worker.",
        spawnable: ["scout"],
        autoExit: true,
        cwd: dir,
        agentDir: dir,
      };
      writeSubagentLoadout(sessionFile, loadout);
      const restored = readSubagentLoadout(sessionFile);
      assert.deepEqual(restored, loadout);

      const parts: string[] = [];
      __test__.applySandboxToParts(parts, restored!, { artifactDir: dir, runId: "worker-run" });
      assert.ok(parts.includes("--no-extensions"));
      assert.ok(parts.includes("--tools"));
      assert.match(parts.join(" "), /provider\/test-model:high/);
      assert.match(parts.join(" "), /--append-system-prompt/);
      assert.ok(existsSync(parts[parts.indexOf("--append-system-prompt") + 1].slice(1, -1)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps omitted and blank application-tool profiles explicitly restricted", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-no-app-tools-"));
    try {
      for (const [index, tools] of [undefined, "", "   "].entries()) {
        const allowlist = __test__.buildSubagentToolAllowlist(tools);
        assert.equal(allowlist, "ask_question");
        assert.deepEqual(__test__.resolveToolExtensionPaths(allowlist), []);
        const loadout: SubagentLoadout = {
          schemaVersion: 2,
          runtime: "pi",
          agent: "no-app-tools",
          toolAllowlist: allowlist,
          extensionPaths: [],
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        };
        const assertRestrictedParts = (parts: string[]) => {
          assert.ok(parts.includes("--no-extensions"));
          assert.ok(parts.includes("--tools"));
          assert.match(parts.join(" "), /ask_question/);
          assert.doesNotMatch(parts.join(" "), /\bread\b|\bwrite\b|\bedit\b|\bbash\b|\bsubagent\b/);
        };

        const freshParts: string[] = [];
        __test__.applySandboxToParts(freshParts, loadout, { artifactDir: dir, runId: `fresh-${index}` });
        assertRestrictedParts(freshParts);

        const sessionFile = join(dir, `child-${index}.jsonl`);
        writeSubagentLoadout(sessionFile, loadout);
        const resumedParts: string[] = [];
        __test__.applySandboxToParts(resumedParts, readSubagentLoadout(sessionFile)!, {
          artifactDir: dir,
          runId: `resume-${index}`,
        });
        assertRestrictedParts(resumedParts);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves backing extensions once and replays the persisted paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-resume-extensions-"));
    try {
      const freshExtension = join(dir, "fresh-extension.ts");
      const replacementExtension = join(dir, "replacement-extension.ts");
      writeFileSync(freshExtension, "export default () => {};\n");
      writeFileSync(replacementExtension, "export default () => {};\n");
      registerToolExtension("resume_path_fresh_fixture", freshExtension);
      registerToolExtension("resume_path_replacement_fixture", replacementExtension);

      assert.deepEqual(
        __test__.resolveToolExtensionPaths("read,ask_question,resume_path_fresh_fixture"),
        [freshExtension],
      );
      const spawnAllowlist = __test__.buildSubagentToolAllowlist(undefined, { grantSpawning: true });
      assert.match(spawnAllowlist, /subagent/);
      const spawnPaths = __test__.resolveToolExtensionPaths(spawnAllowlist);
      assert.equal(spawnPaths.length, 1);
      assert.ok(spawnPaths[0].endsWith("/pi-extension/subagents/index.ts"));

      const sessionFile = join(dir, "child.jsonl");
      const loadout: SubagentLoadout = {
        schemaVersion: 2,
        runtime: "pi",
        agent: "worker",
        toolAllowlist: "resume_path_replacement_fixture,ask_question",
        extensionPaths: [freshExtension],
        model: null,
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: true,
        cwd: dir,
        agentDir: dir,
      };
      writeSubagentLoadout(sessionFile, loadout);
      const restored = readSubagentLoadout(sessionFile)!;
      const parts: string[] = [];
      __test__.applySandboxToParts(parts, restored, { artifactDir: dir, runId: "resume-path" });
      assert.ok(parts.join(" ").includes(freshExtension));
      assert.ok(!parts.join(" ").includes(replacementExtension));

      rmSync(freshExtension);
      const refusedParts: string[] = [];
      assert.throws(
        () => __test__.applySandboxToParts(refusedParts, restored, { artifactDir: dir, runId: "missing-path" }),
        /persisted backing extension is unavailable/,
      );
      assert.deepEqual(refusedParts, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unsupported, unversioned, and unsafe legacy snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-resume-runtime-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      writeFileSync(`${sessionFile}.loadout.json`, JSON.stringify({ schemaVersion: 2, runtime: "claude" }));
      assert.equal(readSubagentLoadout(sessionFile), null);
      writeFileSync(`${sessionFile}.loadout.json`, JSON.stringify({ agent: "legacy" }));
      assert.equal(readSubagentLoadout(sessionFile), null);
      writeFileSync(`${sessionFile}.loadout.json`, JSON.stringify({
        schemaVersion: 1,
        runtime: "pi",
        toolAllowlist: null,
      }));
      assert.equal(readSubagentLoadout(sessionFile), null);
      writeFileSync(`${sessionFile}.loadout.json`, JSON.stringify({
        schemaVersion: 2,
        runtime: "pi",
        agent: "unsafe-null",
        toolAllowlist: null,
        extensionPaths: [],
        model: null,
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: true,
        cwd: null,
        agentDir: null,
      }));
      assert.equal(readSubagentLoadout(sessionFile), null);
      writeFileSync(`${sessionFile}.loadout.json`, JSON.stringify({
        schemaVersion: 2,
        runtime: "pi",
        toolAllowlist: "read,ask_question",
      }));
      assert.equal(readSubagentLoadout(sessionFile), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assigns a fresh authenticated run and sidecars when resuming the same session", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-resume-run-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      const first = createRunControlIdentity("initial-run", sessionFile);
      const resumed = createRunControlIdentity("resume-run", sessionFile);
      assert.notEqual(first.token, resumed.token);
      assert.notEqual(getRunFiles(dir, first.runId).exitFile, getRunFiles(dir, resumed.runId).exitFile);
      assert.equal(resumed.sessionFile, sessionFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
