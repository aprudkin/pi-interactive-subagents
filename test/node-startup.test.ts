import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunControlIdentity } from "../pi-extension/subagents/control.ts";
import { createSupervisedCommand, getRunFiles, readProcessExitRecord, readProcessStartRecord } from "../pi-extension/subagents/run-state.ts";

const realNode = process.execPath;
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
const originalPath = process.env.PATH;
const cleanups: Array<() => void> = [];
afterEach(() => {
  Object.defineProperty(process, "execPath", execPathDescriptor);
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "node-startup-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin with 'quote");
  mkdirSync(bin);
  const node = join(bin, "node");
  process.env.PATH = bin;
  Object.defineProperty(process, "execPath", { ...execPathDescriptor, value: join(dir, "removed-node") });
  const identity = createRunControlIdentity("fixture", join(dir, "session.jsonl"));
  const files = getRunFiles(dir, identity.runId);
  return { dir, bin, node, identity, files };
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

it("preserves an executable parent Node without consulting PATH", () => {
  const f = fixture();
  Object.defineProperty(process, "execPath", { ...execPathDescriptor, value: realNode });
  writeFileSync(f.node, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const command = createSupervisedCommand("exit 0", f.files, f.identity);
  assert.ok(command.startsWith(`exec ${quote(realNode)} `));
});

it("recovers a removed parent path and runs the real supervisor through a quoted PATH symlink", () => {
  const f = fixture();
  symlinkSync(realNode, f.node);
  const command = createSupervisedCommand("exit 0", f.files, f.identity);
  assert.ok(command.startsWith(`exec ${quote(f.node)} `));
  execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
    timeout: 5_000, killSignal: "SIGKILL", stdio: "pipe",
  });
  assert.ok(readProcessStartRecord(f.files.startFile, f.identity));
  assert.equal(readProcessExitRecord(f.files.exitFile, f.identity)?.exitCode, 0);
  assert.equal(JSON.parse(readFileSync(f.files.supervisorConfigFile, "utf8")).command, "exit 0");
});

it("resolves again on each launch rather than caching a subsequently removed parent", () => {
  const f = fixture();
  const parentNode = join(f.dir, "parent-node");
  symlinkSync(realNode, parentNode);
  Object.defineProperty(process, "execPath", { ...execPathDescriptor, value: parentNode });
  symlinkSync(realNode, f.node);
  assert.ok(createSupervisedCommand("exit 0", f.files, f.identity).startsWith(`exec ${quote(parentNode)} `));
  rmSync(parentNode);
  assert.ok(createSupervisedCommand("exit 0", f.files, f.identity).startsWith(`exec ${quote(f.node)} `));
});

for (const missing of ["empty PATH", "unset PATH", "non-executable", "directory", "broken symlink"]) {
  it(`fails before writing supervisor config with ${missing}`, () => {
    const f = fixture();
    if (missing === "empty PATH") process.env.PATH = "";
    if (missing === "unset PATH") delete process.env.PATH;
    if (missing === "non-executable") {
      writeFileSync(f.node, "not executable");
      chmodSync(f.node, 0o644);
    }
    if (missing === "directory") mkdirSync(f.node);
    if (missing === "broken symlink") symlinkSync(join(f.dir, "gone"), f.node);
    assert.throws(() => createSupervisedCommand("exit 0", f.files, f.identity), /Cannot launch subagent supervisor.*Node.*PATH.*[Rr]estart/);
    assert.equal(existsSync(f.files.supervisorConfigFile), false);
  });
}

for (const version of ["22.19.0", "23.0.0", "26.9.0"]) {
  it(`accepts the package's supported Node version (${version})`, () => {
    const f = fixture();
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(manifest.engines.node, ">=22.19.0", "update the runtime floor and its boundary tests together");
    writeFileSync(f.node, `#!/bin/sh\nprintf '%s' '${version}'\n`, { mode: 0o755 });
    assert.ok(createSupervisedCommand("exit 0", f.files, f.identity).startsWith(`exec ${quote(f.node)} `));
  });
}

for (const version of ["22.18.0", "20.20.0", "22.19.0-pre", "not-node"]) {
  it(`rejects an incompatible PATH runtime (${version}) without searching past it`, () => {
    const f = fixture();
    writeFileSync(f.node, `#!/bin/sh\nprintf '%s' '${version}'\n`, { mode: 0o755 });
    process.env.PATH += `:${join(f.dir, "later")}`;
    mkdirSync(join(f.dir, "later"));
    symlinkSync(realNode, join(f.dir, "later", "node"));
    assert.throws(() => createSupervisedCommand("exit 0", f.files, f.identity), /Cannot launch subagent supervisor.*22\.19\.0/);
    assert.equal(existsSync(f.files.supervisorConfigFile), false);
  });
}

it("bounds the fallback probe and reports an actionable error", () => {
  const f = fixture();
  writeFileSync(f.node, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
  const start = Date.now();
  assert.throws(() => createSupervisedCommand("exit 0", f.files, f.identity), /Cannot launch subagent supervisor.*[Rr]estart/);
  assert.ok(Date.now() - start < 4_000, "runtime probe must not wait for the sleeping fixture");
  assert.equal(existsSync(f.files.supervisorConfigFile), false);
});
