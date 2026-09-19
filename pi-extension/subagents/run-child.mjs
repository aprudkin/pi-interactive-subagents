#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const configPath = process.argv[2];
if (!configPath) process.exit(125);

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  process.exit(125);
}

// Cancellation is sent to the entire detached process group. Keep this
// authenticated group leader alive while the payload handles the soft signal;
// the supervisor escalates the whole group after its bounded grace period.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {});
}

let child;
try {
  // This process is the detached process-group leader created by the
  // supervisor. The command remains in the same group, while this stable
  // marker command lets the parent authenticate the group after supervisor
  // loss before sending a signal to it.
  child = spawn("/bin/bash", ["-c", config.command], {
    detached: false,
    stdio: "inherit",
    env: process.env,
  });
} catch {
  process.exit(127);
}

child.once("error", () => { process.exitCode = 127; });
child.once("close", (code, signal) => {
  process.exit(typeof code === "number" ? code : signal ? 128 : 1);
});
