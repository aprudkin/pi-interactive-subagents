import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";

const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  __test__.reservedNames.clear();
  __test__.reservedSessionPaths.clear();
  __test__.runningSubagents.clear();
});

describe("review-cycle round 1 regressions", { concurrency: 1 }, () => {
  it("resolves the declared agent name from the precedence-selected definition", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-definition-"));
    try {
      const globalDir = join(dir, "global");
      const projectDir = join(dir, "project");
      mkdirSync(join(globalDir, "agents"), { recursive: true });
      mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(globalDir, "agents", "global-filename.md"),
        "---\nname: scout\ndescription: global\nmodel: global/model\ntools: read\n---\nglobal body\n",
      );
      writeFileSync(
        join(projectDir, ".pi", "agents", "unrelated-filename.md"),
        "---\nname: scout\ndescription: project\nmodel: project/model\ntools: read, edit\n---\nproject body\n",
      );

      process.env.PI_CODING_AGENT_DIR = globalDir;
      process.chdir(projectDir);
      const selected = __test__.discoverAgentDefinitions().find((agent) => agent.name === "scout");
      assert.equal(selected?.source, "project");
      assert.equal(selected?.model, "project/model");
      assert.equal(selected?.tools, "read, edit");
      assert.equal(selected?.body, "project body");
      assert.deepEqual(__test__.loadAgentDefaults("scout"), selected);
      assert.equal(__test__.isDiscoveredAgentDefinitionAvailable(selected!), true);
      rmSync(join(projectDir, ".pi", "agents", "unrelated-filename.md"));
      assert.equal(__test__.isDiscoveredAgentDefinitionAvailable(selected!), false);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reserves canonical resume paths synchronously and releases them", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-reservation-"));
    try {
      const session = join(dir, "child.jsonl");
      const alias = join(dir, "child-alias.jsonl");
      writeFileSync(session, "{}\n");
      symlinkSync(session, alias);
      const reservation = __test__.reserveSessionForResume(session);
      assert.equal(typeof reservation, "string");
      assert.equal(reservation, __test__.canonicalSessionFilePath(alias));
      assert.equal(__test__.reserveSessionForResume(alias), null);
      __test__.releaseResumeReservation(reservation!);
      assert.equal(typeof __test__.reserveSessionForResume(alias), "string");

      __test__.runningSubagents.set("linked-run", {
        id: "linked-run",
        name: "linked-agent",
        sessionFile: session,
      } as any);
      assert.equal(__test__.findRunningBySessionPath(alias)?.name, "linked-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suffixes explicit names around persistent and in-flight handles", () => {
    const registryNames = new Set(["named", "named-2"]);
    assert.equal(__test__.uniqueRunningName("named", registryNames), "named-3");
    __test__.reservedNames.add("named-3");
    assert.equal(__test__.uniqueRunningName("named", registryNames), "named-4");
    __test__.reservedNames.delete("named-3");
    assert.equal(__test__.uniqueRunningName("named", registryNames), "named-3");
  });

  it("uses run identity for every launch-owned artifact path", () => {
    const first = __test__.getLaunchArtifactPaths("/artifacts", "run-a");
    const second = __test__.getLaunchArtifactPaths("/artifacts", "run-b");
    assert.equal(new Set(Object.values(first)).size, 4);
    for (const key of Object.keys(first) as Array<keyof typeof first>) {
      assert.notEqual(first[key], second[key]);
      assert.match(first[key], /run-a/);
      assert.match(second[key], /run-b/);
    }
  });

  it("renders typed raw summaries verbatim and parses only legacy messages", () => {
    const embeddedFollowUp = "Result line\n\nFollow up with subagent_message is part of the result.";
    const presentation =
      `Sub-agent \"worker\" completed (2s).\n\n${embeddedFollowUp}` +
      "\n\nFollow up with subagent_message({ name: \"worker\", message: \"…\" })";

    assert.equal(
      __test__.resolveRenderedResultSummary(
        { name: "worker", exitCode: 0, elapsed: 2, summary: embeddedFollowUp },
        "wording may change completely",
      ),
      embeddedFollowUp,
    );
    assert.equal(
      __test__.resolveRenderedResultSummary(
        { name: "worker", exitCode: 0, elapsed: 2, summary: "" },
        presentation,
      ),
      "",
    );
    const legacyPresentation =
      "Sub-agent \"worker\" completed (2s).\n\nLegacy result" +
      "\n\nFollow up with subagent_message({ name: \"worker\", message: \"…\" })";
    assert.equal(
      __test__.resolveRenderedResultSummary(
        { name: "worker", exitCode: 0, elapsed: 2 },
        legacyPresentation,
      ),
      "Legacy result",
    );

    const renderers = new Map<string, any>();
    const pi: any = {
      events: { emit() {}, on() { return () => {}; } },
      on() {},
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
    };
    subagentsExtension(pi);
    const theme: any = {
      fg(_color: string, text: string) { return text; },
      bg(_color: string, text: string) { return text; },
      bold(text: string) { return text; },
    };
    const renderResult = (content: string, details: Record<string, unknown>): string => {
      const component = renderers.get("subagent_result")(
        { content, details },
        { expanded: true },
        theme,
      );
      return component.render(120).join("\n");
    };

    for (const name of ["fresh-worker", "resumed-worker"]) {
      const rendered = renderResult(
        `PRESENTATION_WORDING_MUST_NOT_RENDER_${name}`,
        { name, exitCode: 0, elapsed: 2, summary: embeddedFollowUp },
      );
      assert.match(rendered, /Result line/);
      assert.match(rendered, /part of the result/);
      assert.doesNotMatch(rendered, new RegExp(`PRESENTATION_WORDING_MUST_NOT_RENDER_${name}`));
    }

    const failedSummary = "Failed raw result\n\nFollow up with subagent_message remains summary text.";
    const failed = renderResult(
      "FAILED_PRESENTATION_WRAPPER",
      { name: "failed-worker", exitCode: 7, elapsed: 3, summary: failedSummary },
    );
    assert.match(failed, /failed \(exit 7\)/);
    assert.match(failed, /remains summary text/);
    assert.doesNotMatch(failed, /FAILED_PRESENTATION_WRAPPER/);

    const providerFailure = renderResult(
      "PROVIDER_PRESENTATION_WRAPPER",
      {
        name: "provider-worker",
        exitCode: 0,
        elapsed: 4,
        errorMessage: "provider unavailable",
        summary: "Provider raw failure summary",
      },
    );
    assert.match(providerFailure, /failed \(provider\/agent error\)/);
    assert.match(providerFailure, /Error: provider unavailable/);
    assert.match(providerFailure, /Provider raw failure summary/);
    assert.doesNotMatch(providerFailure, /PROVIDER_PRESENTATION_WRAPPER/);

    // R9 round 2: both completion producers can preserve earlier assistant
    // text while recording a later provider/process failure separately.
    for (const name of ["fresh-worker", "resumed-worker"]) {
      for (const errorMessage of ["provider unavailable", "pane disappeared; session may be resumed"]) {
        const content = `MODEL_FACING_WRAPPER: ${errorMessage}`;
        const details = {
          name, exitCode: 1, elapsed: 4, errorMessage, summary: embeddedFollowUp,
        };
        const before = JSON.stringify({ content, details });
        const rendered = renderResult(content, details);
        assert.ok(rendered.includes(`Error: ${errorMessage}`));
        assert.match(rendered, /Result line/);
        assert.match(rendered, /part of the result/);
        assert.doesNotMatch(rendered, /MODEL_FACING_WRAPPER/);
        assert.equal(JSON.stringify({ content, details }), before);
      }
    }

    const executionFailure = renderResult(
      "EXECUTION_PRESENTATION_WRAPPER",
      { name: "execution-worker", error: "watch failed", summary: "Execution raw failure summary" },
    );
    assert.match(executionFailure, /failed/);
    assert.match(executionFailure, /Execution raw failure summary/);

    const legacyFailure = renderResult(
      "Sub-agent \"legacy-worker\" failed (exit code 9).\n\nLegacy failure result" +
        "\n\nFollow up with subagent_message({ name: \"legacy-worker\", message: \"…\" })",
      { name: "legacy-worker", exitCode: 9, elapsed: 5 },
    );
    assert.match(legacyFailure, /failed \(exit 9\)/);
    assert.match(legacyFailure, /Legacy failure result/);

    const legacyProviderFailure = renderResult(
      "Sub-agent \"legacy-provider\" failed after 6s (provider/agent error — auto-retry exhausted)." +
        "\n\nError: provider outage\n\nThe subagent did not produce a result." +
        "\n\nFollow up with subagent_message({ name: \"legacy-provider\", message: \"…\" })",
      { name: "legacy-provider", exitCode: 0, elapsed: 6, errorMessage: "provider outage" },
    );
    assert.match(legacyProviderFailure, /failed \(provider\/agent error\)/);
    assert.match(legacyProviderFailure, /Error: provider outage/);
    assert.equal(legacyProviderFailure.match(/Error: provider outage/g)?.length, 1);
  });
});
