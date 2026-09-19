import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("isolated Pi package discovery", () => {
  it("loads only this package extension and preserves its three-tool contract", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "interactive-subagents-loader-"));
    cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
    const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
    const loader = new DefaultResourceLoader({
      cwd: isolated,
      agentDir: join(isolated, "empty-agent-dir"),
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual(
      [...loaded.extensions[0].tools.keys()].sort(),
      ["subagent", "subagent_message", "subagents_list"],
    );
    assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
    assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
    assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
    assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
  });

  it("does not ship the unsupported Claude plugin payload", () => {
    const output = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: packageDir, encoding: "utf8" },
    );
    const report = JSON.parse(output);
    assert.equal(report.length, 1);
    const packedPaths = report[0].files.map(({ path }: { path: string }) => path);
    assert.equal(
      packedPaths.some((path: string) => path.startsWith("pi-extension/subagents/plugin/")),
      false,
    );
  });
});
