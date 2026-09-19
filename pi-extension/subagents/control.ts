import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROTOCOL_VERSION = 1;
const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
const MAX_FRAME_BYTES = 1024 * 1024;

interface HelloFrame {
  version: 1;
  type: "hello";
  runId: string;
  token: string;
  sessionFile: string;
}

interface DeliverFrame {
  version: 1;
  type: "deliver";
  requestId: string;
  message: string;
}

interface AckFrame {
  version: 1;
  type: "ack";
  requestId: string;
  status: "dispatch-invoked" | "not-delivered";
  mode?: "immediate" | "steer";
  reason?: string;
}

interface CompleteFrame {
  version: 1;
  type: "complete";
  runId: string;
}

type ChildFrame = HelloFrame | AckFrame | CompleteFrame;

/**
 * Pi 0.85.1's extension API returns void from sendUserMessage and reports
 * asynchronous prompt failures separately through the runtime error channel.
 * Consequently no socket response can truthfully prove queue acceptance.
 */
export type DeliveryResult =
  | {
      status: "delivery-unknown";
      childReceived: boolean;
      dispatchInvoked: boolean;
      mode?: "immediate" | "steer";
      reason: string;
    }
  | { status: "not-delivered"; reason: string };

export interface RunControlIdentity {
  runId: string;
  token: string;
  sessionFile: string;
}

export function createRunControlIdentity(runId: string, sessionFile: string): RunControlIdentity {
  return { runId, sessionFile, token: randomBytes(32).toString("hex") };
}

function encodeFrame(frame: object): string {
  return `${JSON.stringify(frame)}\n`;
}

function safeWrite(socket: Socket, frame: object): boolean {
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.write(encodeFrame(frame), (error) => {
      if (error) socket.destroy(error);
    });
    return true;
  } catch (error) {
    socket.destroy(error instanceof Error ? error : undefined);
    return false;
  }
}

function installFrameReader(socket: Socket, onFrame: (frame: unknown) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      socket.destroy(new Error("Subagent control frame exceeded the size limit"));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        onFrame(JSON.parse(line));
      } catch {
        socket.destroy(new Error("Invalid subagent control frame"));
        return;
      }
    }
  });
}

interface PendingDelivery {
  resolve(result: DeliveryResult): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class ParentRunControlServer {
  readonly socketPath: string;
  private readonly ownedDir: string | null;
  private readonly identity: RunControlIdentity;
  private readonly handshakeTimeoutMs: number;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private socketPathOwned = false;
  private completed = false;
  private closed = false;
  private readonly sockets = new Set<Socket>();
  private readonly handshakeTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, PendingDelivery>();

  constructor(
    identity: RunControlIdentity,
    options: { socketPath?: string; handshakeTimeoutMs?: number } = {},
  ) {
    this.identity = identity;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (options.socketPath) {
      this.socketPath = options.socketPath;
      this.ownedDir = null;
    } else {
      const base = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? "user"}`);
      mkdirSync(base, { recursive: true, mode: 0o700 });
      chmodSync(base, 0o700);
      this.ownedDir = mkdtempSync(join(base, "run-"));
      chmodSync(this.ownedDir, 0o700);
      this.socketPath = join(this.ownedDir, "control.sock");
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.closed) throw new Error("Cannot start a closed subagent control server");

    const server = createServer((socket) => this.accept(socket));
    // Keep a listener after startup too: a later accept/listener error must not
    // become an uncaught exception in the orchestrator process.
    server.on("error", () => undefined);
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          server.off("error", onError);
          if (error) reject(error);
          else resolve();
        };
        const onError = (error: Error) => finish(error);
        server.once("error", onError);
        server.listen(this.socketPath, () => {
          this.socketPathOwned = true;
          try {
            chmodSync(this.socketPath, 0o600);
            finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    } catch (error) {
      await this.cleanupServer(server);
      this.server = null;
      this.closed = true;
      if (this.ownedDir) {
        try { rmSync(this.ownedDir, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    // Always install an error listener before reads/writes. Buffered disconnects
    // can otherwise surface as an unhandled EPIPE in the orchestrator process.
    socket.on("error", () => undefined);

    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) socket.destroy(new Error("Subagent control handshake timed out"));
    }, this.handshakeTimeoutMs);
    this.handshakeTimers.set(socket, handshakeTimer);

    const cleanupSocket = () => {
      const timer = this.handshakeTimers.get(socket);
      if (timer) clearTimeout(timer);
      this.handshakeTimers.delete(socket);
      this.sockets.delete(socket);
      if (this.socket !== socket) return;
      this.socket = null;
      for (const [requestId, pending] of this.pending) {
        this.settlePending(requestId, pending, {
          status: "delivery-unknown",
          childReceived: false,
          dispatchInvoked: false,
          reason:
            "The authenticated control channel disconnected before reporting dispatch. " +
            "Do not retry automatically because the child may already have received the message.",
        });
      }
    };
    socket.once("close", cleanupSocket);

    if (this.closed || this.socket) {
      socket.destroy();
      return;
    }

    let firstFrame = true;
    installFrameReader(socket, (raw) => {
      const frame = raw as Partial<ChildFrame>;
      if (firstFrame) {
        firstFrame = false;
        const valid =
          frame.version === PROTOCOL_VERSION &&
          frame.type === "hello" &&
          frame.runId === this.identity.runId &&
          (frame as Partial<HelloFrame>).token === this.identity.token &&
          (frame as Partial<HelloFrame>).sessionFile === this.identity.sessionFile;
        if (!valid || this.socket || this.closed) {
          socket.destroy();
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        this.handshakeTimers.delete(socket);
        this.socket = socket;
        return;
      }

      if (!authenticated || this.socket !== socket) return;
      if (frame.type === "ack" && typeof frame.requestId === "string") {
        const pending = this.pending.get(frame.requestId);
        if (!pending) return;
        if (
          frame.status === "dispatch-invoked" &&
          (frame.mode === "immediate" || frame.mode === "steer")
        ) {
          this.settlePending(frame.requestId, pending, {
            status: "delivery-unknown",
            childReceived: true,
            dispatchInvoked: true,
            mode: frame.mode,
            reason:
              "The authenticated child received the message and invoked Pi sendUserMessage, " +
              "but Pi exposes no correlated acceptance result. Do not retry automatically.",
          });
        } else {
          this.settlePending(frame.requestId, pending, {
            status: "not-delivered",
            reason: frame.reason || "The child rejected the message before dispatch.",
          });
        }
      } else if (frame.type === "complete" && frame.runId === this.identity.runId) {
        this.completed = true;
      }
    });
  }

  private settlePending(
    requestId: string,
    pending: PendingDelivery,
    result: DeliveryResult,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(result);
  }

  markCompleted(): void {
    this.completed = true;
  }

  async deliver(message: string, timeoutMs = DEFAULT_ACK_TIMEOUT_MS): Promise<DeliveryResult> {
    if (this.completed) {
      return { status: "not-delivered", reason: "The subagent has already completed this run." };
    }
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      return {
        status: "not-delivered",
        reason: "The authenticated subagent control channel is not connected.",
      };
    }

    const requestId = randomBytes(16).toString("hex");
    return new Promise<DeliveryResult>((resolve) => {
      const pending: PendingDelivery = {
        resolve,
        settled: false,
        timer: setTimeout(() => {
          this.settlePending(requestId, pending, {
            status: "delivery-unknown",
            childReceived: false,
            dispatchInvoked: false,
            reason:
              "The child did not report dispatch before the deadline. Do not retry automatically " +
              "because it may already have received the message.",
          });
        }, timeoutMs),
      };
      this.pending.set(requestId, pending);
      if (!safeWrite(socket, {
        version: PROTOCOL_VERSION,
        type: "deliver",
        requestId,
        message,
      } satisfies DeliverFrame)) {
        this.settlePending(requestId, pending, {
          status: "delivery-unknown",
          childReceived: false,
          dispatchInvoked: false,
          reason:
            "The control write failed synchronously. Do not retry automatically because delivery is uncertain.",
        });
      }
    });
  }

  private async cleanupServer(server: Server): Promise<void> {
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer);
    this.handshakeTimers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      try { server.close(() => resolve()); } catch { resolve(); }
    });
    if (this.socketPathOwned) {
      try { rmSync(this.socketPath, { force: true }); } catch {}
      this.socketPathOwned = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.settlePending(requestId, pending, {
        status: "delivery-unknown",
        childReceived: false,
        dispatchInvoked: false,
        reason: "The run control server closed during delivery; delivery is uncertain.",
      });
    }
    const server = this.server;
    this.server = null;
    if (server) await this.cleanupServer(server);
    try {
      if (this.socketPathOwned) rmSync(this.socketPath, { force: true });
      this.socketPathOwned = false;
      if (this.ownedDir) rmSync(this.ownedDir, { recursive: true, force: true });
    } catch {}
  }
}

export interface ChildRunControl {
  notifyCompleted(): void;
  close(): void;
}

export function connectChildRunControl(params: {
  identity: RunControlIdentity;
  socketPath: string;
  dispatch(message: string): "immediate" | "steer";
}): ChildRunControl {
  const socket = createConnection(params.socketPath);
  let connected = false;
  let completed = false;

  socket.on("error", () => undefined);
  socket.on("connect", () => {
    connected = safeWrite(socket, {
      version: PROTOCOL_VERSION,
      type: "hello",
      ...params.identity,
    } satisfies HelloFrame);
  });
  installFrameReader(socket, (raw) => {
    const frame = raw as Partial<DeliverFrame>;
    if (
      !connected ||
      frame.version !== PROTOCOL_VERSION ||
      frame.type !== "deliver" ||
      typeof frame.requestId !== "string" ||
      typeof frame.message !== "string"
    ) return;
    if (completed) {
      safeWrite(socket, {
        version: PROTOCOL_VERSION,
        type: "ack",
        requestId: frame.requestId,
        status: "not-delivered",
        reason: "The subagent run is already complete.",
      } satisfies AckFrame);
      return;
    }
    try {
      const mode = params.dispatch(frame.message);
      safeWrite(socket, {
        version: PROTOCOL_VERSION,
        type: "ack",
        requestId: frame.requestId,
        status: "dispatch-invoked",
        mode,
      } satisfies AckFrame);
    } catch (error) {
      safeWrite(socket, {
        version: PROTOCOL_VERSION,
        type: "ack",
        requestId: frame.requestId,
        status: "not-delivered",
        reason: error instanceof Error ? error.message : String(error),
      } satisfies AckFrame);
    }
  });

  return {
    notifyCompleted() {
      if (completed) return;
      completed = true;
      safeWrite(socket, {
        version: PROTOCOL_VERSION,
        type: "complete",
        runId: params.identity.runId,
      } satisfies CompleteFrame);
    },
    close() {
      socket.destroy();
    },
  };
}
