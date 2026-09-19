import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectChildRunControl,
  createRunControlIdentity,
  ParentRunControlServer,
  type ChildRunControl,
} from "../pi-extension/subagents/control.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectedPair(dispatch: (message: string) => "immediate" | "steer") {
  const dir = mkdtempSync(join(tmpdir(), "subagent-control-test-"));
  const identity = createRunControlIdentity("run-1", join(dir, "session.jsonl"));
  const server = new ParentRunControlServer(identity, {
    socketPath: join(dir, "control.sock"),
    handshakeTimeoutMs: 50,
  });
  await server.start();
  const child = connectChildRunControl({ identity, socketPath: server.socketPath, dispatch });
  cleanups.push(() => child.close(), () => server.close(), () => rmSync(dir, { recursive: true, force: true }));
  await delay(30);
  return { server, child };
}

describe("authenticated per-run control transport", () => {
  it("delivers the exact multiline message once but reports Pi acceptance as unknowable", async () => {
    const received: string[] = [];
    const { server } = await connectedPair((message) => {
      received.push(message);
      return "steer";
    });

    const result = await server.deliver("first line\nsecond line");
    assert.equal(result.status, "delivery-unknown");
    assert.equal(result.childReceived, true);
    assert.equal(result.dispatchInvoked, true);
    assert.equal(result.mode, "steer");
    assert.deepEqual(received, ["first line\nsecond line"]);
  });

  it("cleans up a wrong-token peer and permits the valid child afterward", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-control-auth-"));
    const identity = createRunControlIdentity("run-auth", join(dir, "session.jsonl"));
    const server = new ParentRunControlServer(identity, {
      socketPath: join(dir, "control.sock"),
      handshakeTimeoutMs: 50,
    });
    await server.start();
    const impostor = connectChildRunControl({
      identity: { ...identity, token: "wrong-token" },
      socketPath: server.socketPath,
      dispatch: () => "steer",
    });
    cleanups.push(() => impostor.close(), () => server.close(), () => rmSync(dir, { recursive: true, force: true }));
    await delay(30);

    assert.equal((await server.deliver("must not cross runs")).status, "not-delivered");
    const valid = connectChildRunControl({
      identity,
      socketPath: server.socketPath,
      dispatch: () => "immediate",
    });
    cleanups.push(() => valid.close());
    await delay(30);
    const result = await server.deliver("valid run");
    assert.equal(result.status, "delivery-unknown");
    assert.equal(result.dispatchInvoked, true);
  });

  it("expires no-hello peers and close never waits for them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-control-idle-"));
    const identity = createRunControlIdentity("run-idle", join(dir, "session.jsonl"));
    const server = new ParentRunControlServer(identity, {
      socketPath: join(dir, "control.sock"),
      handshakeTimeoutMs: 25,
    });
    await server.start();
    const idle = createConnection(server.socketPath);
    idle.on("error", () => undefined);
    cleanups.push(() => { idle.destroy(); }, () => rmSync(dir, { recursive: true, force: true }));
    await delay(50);
    await Promise.race([
      server.close(),
      delay(250).then(() => { throw new Error("server.close hung on unauthenticated peer"); }),
    ]);
  });

  it("reports uncertain delivery on disconnect and never duplicates", async () => {
    let calls = 0;
    let child!: ChildRunControl;
    const pair = await connectedPair(() => {
      calls += 1;
      child.close();
      return "steer";
    });
    child = pair.child;

    const result = await pair.server.deliver("one attempt", 100);
    assert.equal(result.status, "delivery-unknown");
    assert.equal(calls, 1);
  });

  it("reports a synchronous child dispatch exception as not delivered", async () => {
    const { server } = await connectedPair(() => {
      throw new Error("runtime is stale");
    });
    const result = await server.deliver("cannot dispatch");
    assert.deepEqual(result, { status: "not-delivered", reason: "runtime is stale" });
  });

  it("refuses delivery after completion instead of racing or retrying", async () => {
    let calls = 0;
    const { server } = await connectedPair(() => {
      calls += 1;
      return "immediate";
    });
    server.markCompleted();

    const result = await server.deliver("too late");
    assert.deepEqual(result, { status: "not-delivered", reason: "The subagent has already completed this run." });
    assert.equal(calls, 0);
  });

  it("leaves a caller-supplied socket untouched when start fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-control-owned-"));
    const socketPath = join(dir, "occupied.sock");
    const occupant = createServer();
    await new Promise<void>((resolve, reject) => {
      occupant.once("error", reject);
      occupant.listen(socketPath, resolve);
    });
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => new Promise<void>((resolve) => occupant.close(() => resolve())),
    );

    const identity = createRunControlIdentity("run-fail", join(dir, "session.jsonl"));
    const server = new ParentRunControlServer(identity, { socketPath });
    await assert.rejects(server.start());
    await server.close();
    assert.equal(existsSync(socketPath), true);
  });
});
