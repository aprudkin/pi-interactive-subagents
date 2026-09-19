import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { ParentRunControlServer } from "../pi-extension/subagents/control.ts";

const ENV_KEYS = [
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_CONTROL_TOKEN",
  "PI_SUBAGENT_CONTROL_SOCKET",
  "PI_SUBAGENT_COMPLETION_FILE",
  "PI_SUBAGENT_AUTO_EXIT",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createHarness(dir: string, options: { controlSocket?: string; idle?: boolean } = {}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const completionFile = join(dir, "completion.json");
  process.env.PI_SUBAGENT_ID = "settled-run";
  process.env.PI_SUBAGENT_SESSION = join(dir, "session.jsonl");
  process.env.PI_SUBAGENT_CONTROL_TOKEN = "test-token";
  process.env.PI_SUBAGENT_COMPLETION_FILE = completionFile;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  if (options.controlSocket) process.env.PI_SUBAGENT_CONTROL_SOCKET = options.controlSocket;
  else delete process.env.PI_SUBAGENT_CONTROL_SOCKET;

  const sentUserMessages: Array<{ message: string; options?: { deliverAs?: string } }> = [];
  const api = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    getAllTools() { return []; },
    registerShortcut() {},
    registerTool() {},
    sendUserMessage(message: string, sendOptions?: { deliverAs?: string }) {
      sentUserMessages.push({ message, options: sendOptions });
    },
  } as any;
  subagentDoneExtension(api);

  let shutdowns = 0;
  const ctx = {
    isIdle: () => options.idle ?? true,
    shutdown() { shutdowns += 1; },
    ui: { setWidget() {} },
  };
  const emit = async (name: string, event: any = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { completionFile, emit, sentUserMessages, get shutdowns() { return shutdowns; } };
}

describe("settled completion", () => {
  it("routes live steering through the socket into pi.sendUserMessage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-pi-steer-"));
    const socketPath = join(dir, "control.sock");
    const identity = {
      runId: "settled-run",
      sessionFile: join(dir, "session.jsonl"),
      token: "test-token",
    };
    const server = new ParentRunControlServer(identity, { socketPath });
    try {
      await server.start();
      const harness = createHarness(dir, { controlSocket: socketPath, idle: false });
      await harness.emit("session_start", { reason: "startup" });
      await new Promise((resolve) => setTimeout(resolve, 30));

      const result = await server.deliver("preserve\nthis message");
      assert.equal(result.status, "delivery-unknown");
      assert.equal(result.childReceived, true);
      assert.equal(result.dispatchInvoked, true);
      assert.equal(result.mode, "steer");
      assert.deepEqual(harness.sentUserMessages, [{
        message: "preserve\nthis message",
        options: { deliverAs: "steer" },
      }]);
      await harness.emit("session_shutdown", { reason: "quit" });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not shut down or declare completion at the earlier agent_end event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-settled-"));
    try {
      const harness = createHarness(dir);
      await harness.emit("session_start", { reason: "startup" });
      await harness.emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
      });

      assert.equal(harness.shutdowns, 0);
      assert.equal(existsSync(harness.completionFile), false);

      await harness.emit("agent_settled");
      assert.equal(harness.shutdowns, 1);
      const record = JSON.parse(readFileSync(harness.completionFile, "utf8"));
      assert.equal(record.status, "completed");
      assert.equal(record.runId, "settled-run");
      assert.equal(record.token, "test-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the final low-level run when a later run replaces an earlier error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-retry-"));
    try {
      const harness = createHarness(dir);
      await harness.emit("session_start", { reason: "startup" });
      await harness.emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "temporary", content: [] }],
      });
      await harness.emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] }],
      });
      await harness.emit("agent_settled");

      const record = JSON.parse(readFileSync(harness.completionFile, "utf8"));
      assert.equal(record.status, "completed");
      assert.equal(record.errorMessage, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a terminal agent failure for the parent watcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-error-"));
    try {
      const harness = createHarness(dir);
      await harness.emit("session_start", { reason: "startup" });
      await harness.emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider exhausted retries", content: [] }],
      });
      await harness.emit("agent_settled");

      const record = JSON.parse(readFileSync(harness.completionFile, "utf8"));
      assert.equal(record.status, "error");
      assert.equal(record.errorMessage, "provider exhausted retries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
