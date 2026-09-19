import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { __test__ } from "../pi-extension/subagents/index.ts";
import {
  nameRegistryPath,
  readNameRegistry,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function header(id: string, cwd: string) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-06-01T00:00:00.000Z",
    cwd,
  };
}

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-06-01T00:00:00.000Z",
    message: {
      role,
      content: [{ type: "text", text }],
      ...(role === "assistant"
        ? {
            provider: "fixture-provider",
            model: "fixture-model",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
          }
        : {}),
      timestamp: 1,
    },
  };
}

function writeSession(path: string, entries: object[]): void {
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function readSession(path: string): any[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function seed(mode: "fork" | "lineage-only", entries: object[]) {
  const directory = temporaryDirectory("subagent-session-review-");
  const parentSessionFile = join(directory, "parent.jsonl");
  const childSessionFile = join(directory, "child.jsonl");
  writeSession(parentSessionFile, entries);
  seedSubagentSessionFile({
    mode,
    parentSessionFile,
    childSessionFile,
    childCwd: join(directory, "child-cwd"),
  });
  return { directory, parentSessionFile, childSessionFile };
}

describe("fork session seeding", () => {
  it("follows the invoking task parent ancestry instead of a discarded physical sibling", () => {
    const directory = temporaryDirectory("subagent-session-parent-");
    const entries = [
      header("parent-session", directory),
      message("u0", null, "user", "shared root"),
      message("a0", "u0", "assistant", "shared answer"),
      message("u-old", "a0", "user", "discarded branch instruction"),
      message("a-old", "u-old", "assistant", "discarded branch answer"),
      message("u-task", "a0", "user", "launch the child from the replacement branch"),
    ];
    const { parentSessionFile, childSessionFile } = seed("fork", entries);

    const seeded = readSession(childSessionFile);
    assert.equal(seeded[0].parentSession, parentSessionFile);
    assert.notEqual(seeded[0].id, "parent-session");
    assert.deepEqual(seeded.slice(1).map((entry) => entry.id), ["u0", "a0"]);
    assert.ok(!readFileSync(childSessionFile, "utf8").includes("discarded branch"));
    assert.ok(!readFileSync(childSessionFile, "utf8").includes("launch the child"));

    // Direct fork task delivery appends the task to the selected pre-task leaf.
    const child = SessionManager.open(childSessionFile);
    const taskId = child.appendMessage({
      role: "user",
      content: [{ type: "text", text: "child task" }],
      timestamp: 2,
    });
    assert.deepEqual(child.getBranch(taskId).map((entry) => entry.id), ["u0", "a0", taskId]);
  });

  it("preserves a linear pre-task branch including model metadata", () => {
    const directory = temporaryDirectory("subagent-session-parent-");
    const entries = [
      header("parent-session", directory),
      message("u0", null, "user", "root"),
      message("a0", "u0", "assistant", "answer"),
      {
        type: "model_change",
        id: "model",
        parentId: "a0",
        timestamp: "2026-06-01T00:00:01.000Z",
        provider: "selected-provider",
        modelId: "selected-model",
      },
      message("u-task", "model", "user", "launch child"),
    ];
    const { childSessionFile } = seed("fork", entries);

    assert.deepEqual(readSession(childSessionFile).slice(1).map((entry) => entry.id), [
      "u0",
      "a0",
      "model",
    ]);
    const context = SessionManager.open(childSessionFile).buildSessionContext();
    assert.deepEqual(context.model, {
      provider: "selected-provider",
      modelId: "selected-model",
    });
  });

  it("keeps compaction metadata on the selected branch and excludes compacted sibling entries", () => {
    const directory = temporaryDirectory("subagent-session-parent-");
    const compaction = {
      type: "compaction",
      id: "compact",
      parentId: "model",
      timestamp: "2026-06-01T00:00:02.000Z",
      summary: "selected branch summary",
      firstKeptEntryId: "a0",
      tokensBefore: 4000,
      retainedTail: [{ role: "user", content: "retained fixture", timestamp: 1 }],
      usage: {
        input: 3,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 7,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      details: { marker: "preserve-me" },
    };
    const entries = [
      header("parent-session", directory),
      message("u0", null, "user", "root"),
      message("a0", "u0", "assistant", "answer"),
      message("u-old", "a0", "user", "discarded compacted sibling"),
      message("a-old", "u-old", "assistant", "discarded compacted answer"),
      {
        type: "model_change",
        id: "model",
        parentId: "a0",
        timestamp: "2026-06-01T00:00:01.000Z",
        provider: "selected-provider",
        modelId: "selected-model",
      },
      compaction,
      message("u-task", "compact", "user", "launch child"),
    ];
    const { childSessionFile } = seed("fork", entries);
    const seededEntries = readSession(childSessionFile).slice(1);

    assert.deepEqual(seededEntries.map((entry) => entry.id), ["u0", "a0", "model", "compact"]);
    assert.deepEqual(seededEntries.at(-1), compaction);
    const child = SessionManager.open(childSessionFile);
    assert.deepEqual(child.getBranch().map((entry) => entry.id), ["u0", "a0", "model", "compact"]);
    assert.deepEqual(child.buildContextEntries().map((entry) => entry.id), ["compact", "a0", "model"]);
    assert.deepEqual(child.buildSessionContext().model, {
      provider: "selected-provider",
      modelId: "selected-model",
    });
  });

  it("handles root-task, empty, and user-less legacy paths", () => {
    const directory = temporaryDirectory("subagent-session-parent-");
    const rootTask = seed("fork", [
      header("root-task-parent", directory),
      message("u-task", null, "user", "launch child"),
    ]);
    assert.deepEqual(readSession(rootTask.childSessionFile).slice(1), []);

    const empty = seed("fork", [header("empty-parent", directory)]);
    assert.deepEqual(readSession(empty.childSessionFile).slice(1), []);

    const userless = seed("fork", [
      header("legacy-parent", directory),
      message("a0", null, "assistant", "legacy root assistant"),
    ]);
    assert.deepEqual(readSession(userless.childSessionFile).slice(1).map((entry) => entry.id), ["a0"]);
  });

  it("keeps lineage-only sessions empty while recording ownership", () => {
    const directory = temporaryDirectory("subagent-session-parent-");
    const { parentSessionFile, childSessionFile } = seed("lineage-only", [
      header("parent-session", directory),
      message("u0", null, "user", "root"),
      message("a0", "u0", "assistant", "answer"),
      message("u-task", "a0", "user", "launch child"),
    ]);
    const seeded = readSession(childSessionFile);

    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].parentSession, parentSessionFile);
    assert.equal(seeded[0].cwd, join(dirname(parentSessionFile), "child-cwd"));
  });
});

describe("prototype-like name registry entries", () => {
  it("persists and resolves accepted prototype-like names without prototype mutation", () => {
    const artifactDir = temporaryDirectory("subagent-name-registry-");
    const beforePrototype = Object.getPrototypeOf({});
    const entries = new Map([
      ["__proto__", { sessionFile: "/tmp/proto-child.jsonl", sessionId: "proto-id" }],
      ["constructor", { sessionFile: "/tmp/constructor-child.jsonl", sessionId: "constructor-id" }],
      ["toString", { sessionFile: "/tmp/to-string-child.jsonl", sessionId: "to-string-id" }],
      ["hasOwnProperty", { sessionFile: "/tmp/own-child.jsonl", sessionId: "own-id" }],
    ]);

    for (const [name, entry] of entries) registerName(artifactDir, name, entry);

    const raw = JSON.parse(readFileSync(nameRegistryPath(artifactDir), "utf8"));
    const reread = readNameRegistry(artifactDir);
    assert.deepEqual(Object.keys(raw), [...entries.keys()]);
    assert.deepEqual(Object.keys(reread), [...entries.keys()]);
    for (const [name, entry] of entries) {
      assert.equal(Object.hasOwn(reread, name), true);
      assert.deepEqual(resolveNameInRegistry(artifactDir, name), entry);
    }
    assert.equal(Object.getPrototypeOf({}), beforePrototype);
    assert.equal((Object.prototype as { sessionFile?: unknown }).sessionFile, undefined);
  });

  it("keeps prototype-like finished handles reserved for suffixing after disk reread", () => {
    const artifactDir = temporaryDirectory("subagent-name-registry-");
    const original = { sessionFile: "/tmp/proto-child.jsonl", sessionId: "proto-id" };
    registerName(artifactDir, "__proto__", original);

    const registryNames = new Set(Object.keys(readNameRegistry(artifactDir)));
    assert.equal(__test__.uniqueRunningName("__proto__", registryNames), "__proto__-2");
    assert.deepEqual(resolveNameInRegistry(artifactDir, "__proto__"), original);

    const replacement = { sessionFile: "/tmp/replacement.jsonl", sessionId: "replacement-id" };
    registerName(artifactDir, "__proto__", replacement);
    assert.deepEqual(resolveNameInRegistry(artifactDir, "__proto__"), replacement);
    assert.deepEqual(Object.keys(readNameRegistry(artifactDir)), ["__proto__"]);
  });

  it("retains malformed-registry fallback behavior", () => {
    const artifactDir = temporaryDirectory("subagent-name-registry-");
    writeFileSync(nameRegistryPath(artifactDir), "[]\n");
    assert.deepEqual(readNameRegistry(artifactDir), {});
    assert.equal(resolveNameInRegistry(artifactDir, "constructor"), null);

    writeFileSync(nameRegistryPath(artifactDir), "not json\n");
    assert.deepEqual(readNameRegistry(artifactDir), {});
    assert.equal(resolveNameInRegistry(artifactDir, "__proto__"), null);
  });
});
