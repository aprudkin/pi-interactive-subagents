import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import subagentsExtension, { __test__ as subagentTest } from "../pi-extension/subagents/index.ts";
import {
  WORKFLOW_PRESETS,
  WORKFLOW_PRESET_ENV,
  __test__,
  applyWorkflowPreset,
  getWorkflowPresetPolicyForSpawn,
  installWorkflowPresetExtension,
  persistWorkflowPreset,
  readPersistedWorkflowPreset,
  resolveFreshSubagentProfile,
  resolveWorkflowProjectRoot,
  workflowPresetPath,
} from "../pi-extension/subagents/workflow-presets.ts";
import {
  readSubagentLoadout,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalSubagentId = process.env.PI_SUBAGENT_ID;
const originalPreset = process.env[WORKFLOW_PRESET_ENV];
const cleanupDirs: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalSubagentId === undefined) delete process.env.PI_SUBAGENT_ID;
  else process.env.PI_SUBAGENT_ID = originalSubagentId;
  if (originalPreset === undefined) delete process.env[WORKFLOW_PRESET_ENV];
  else process.env[WORKFLOW_PRESET_ENV] = originalPreset;
  __test__.setActiveTopLevelPolicy(undefined);
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(path);
  return path;
}

function model(provider: string, id: string): any {
  return { provider, id, name: id, reasoning: true };
}

function availablePresetModels(): any[] {
  const keys = new Set<string>();
  const models: any[] = [];
  for (const preset of Object.values(WORKFLOW_PRESETS)) {
    for (const target of [preset.main, ...Object.values(preset.children)]) {
      const key = `${target.provider}/${target.model}`;
      if (!keys.has(key)) {
        keys.add(key);
        models.push(model(target.provider, target.model));
      }
    }
  }
  return models;
}

function createPresetHarness(options: {
  available?: any[];
  initialModel?: any;
  initialThinking?: string;
  clampThinking?: string;
  rejectRollback?: boolean;
} = {}) {
  const initialThinking = options.initialThinking ?? "high";
  const state = {
    model: options.initialModel ?? model("fixture", "original"),
    thinking: initialThinking,
  };
  const setModels: string[] = [];
  const pi: any = {
    async setModel(next: any) {
      setModels.push(`${next.provider}/${next.id}`);
      if (options.rejectRollback && next.provider === "fixture") return false;
      state.model = next;
      return true;
    },
    getThinkingLevel() { return state.thinking; },
    setThinkingLevel(level: string) {
      state.thinking = options.clampThinking && level !== initialThinking
        ? options.clampThinking
        : level;
    },
  };
  const ctx: any = {
    get model() { return state.model; },
    get thinkingLevel() { return state.thinking; },
    modelRegistry: { getAvailable: () => options.available ?? availablePresetModels() },
  };
  return { state, setModels, pi, ctx };
}

describe("workflow preset definitions and routing", { concurrency: 1 }, () => {
  it("uses the final built-in model and effort matrix", () => {
    assert.deepEqual(WORKFLOW_PRESETS, {
      maximum: {
        main: { provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh" },
        children: {
          worker: { provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh" },
          reviewer: { provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh" },
          researcher: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
          scout: { provider: "openai-codex", model: "gpt-6-astra", thinking: "low" },
        },
      },
      optimal: {
        main: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
        children: {
          worker: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
          reviewer: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
          researcher: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
          scout: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low" },
        },
      },
      economical: {
        main: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
        children: {
          worker: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
          reviewer: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "high" },
          researcher: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
          scout: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low" },
        },
      },
    });
  });

  it("keeps no-preset/custom-role defaults, routes nested children, and honors explicit models", () => {
    assert.deepEqual(resolveFreshSubagentProfile({
      role: "worker", defaultModel: "role/default", defaultThinking: "high", policy: "off",
    }), { model: "role/default", thinking: "high", policy: "off" });
    assert.deepEqual(resolveFreshSubagentProfile({
      role: "custom", defaultModel: "custom/default", defaultThinking: "low", policy: "maximum",
    }), { model: "custom/default", thinking: "low", policy: "maximum" });
    assert.deepEqual(resolveFreshSubagentProfile({
      role: "worker",
      explicitModel: "explicit/model",
      defaultModel: "role/default",
      defaultThinking: "high",
      policy: "optimal",
    }), { model: "explicit/model", thinking: "high", policy: "optimal" });

    process.env.PI_SUBAGENT_ID = "nested-parent";
    process.env[WORKFLOW_PRESET_ENV] = "economical";
    assert.deepEqual(resolveFreshSubagentProfile({ role: "reviewer", defaultModel: "ignored" }), {
      model: "openai-codex/gpt-5.6-terra",
      thinking: "high",
      policy: "economical",
    });
  });

  it("reports effective preset routing through subagents_list", async () => {
    delete process.env.PI_SUBAGENT_ID;
    const root = temporaryDir("workflow-list-");
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(join(project, ".git"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    persistWorkflowPreset("optimal", project, agentDir);
    const tools = new Map<string, any>();
    subagentsExtension({
      events: { emit() {}, on() { return () => {}; } },
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      sendUserMessage() {},
    } as any);
    const result = await tools.get("subagents_list").execute(
      "list-call",
      {},
      new AbortController().signal,
      () => {},
      { cwd: project },
    );
    const worker = result.details.agents.find((agent: any) => agent.name === "worker");
    const scout = result.details.agents.find((agent: any) => agent.name === "scout");
    assert.equal(worker.model, "openai-codex/gpt-5.6-sol");
    assert.equal(worker.thinking, "medium");
    assert.equal(scout.model, "openai-codex/gpt-5.6-luna");
    assert.equal(scout.thinking, "low");
    assert.match(result.content[0].text, /openai-codex\/gpt-5\.6-sol:medium/);
  });

  it("pins the selected policy and routed model in fresh loadouts while resume replays them", () => {
    delete process.env.PI_SUBAGENT_ID;
    __test__.setActiveTopLevelPolicy("maximum");
    const prepared = subagentTest.prepareAgentLaunchProfile(
      { agent: "worker", task: "fixture" },
      {
        name: "worker",
        disableModelInvocation: false,
        model: "role/default",
        thinking: "medium",
        tools: "read",
      } as any,
    );
    assert.equal(prepared.loadout.model, "openai-codex/gpt-6-astra");
    assert.equal(prepared.loadout.thinking, "xhigh");
    assert.equal(prepared.loadout.workflowPreset, "maximum");

    const dir = temporaryDir("workflow-loadout-");
    const sessionFile = join(dir, "child.jsonl");
    const loadout: SubagentLoadout = {
      schemaVersion: 2,
      runtime: "pi",
      agent: "worker",
      ...prepared.loadout,
      cwd: null,
      agentDir: dir,
    };
    writeSubagentLoadout(sessionFile, loadout);
    __test__.setActiveTopLevelPolicy("economical");
    assert.deepEqual(readSubagentLoadout(sessionFile), loadout);

    const offLoadout = { ...loadout, workflowPreset: "off" as const };
    writeSubagentLoadout(sessionFile, offLoadout);
    assert.equal(readSubagentLoadout(sessionFile)?.workflowPreset, "off");
  });
});

describe("workflow preset application and persistence", { concurrency: 1 }, () => {
  it("isolates canonical project selections without touching settings", () => {
    const root = temporaryDir("workflow-persist-");
    const agentDir = join(root, "agent");
    const projectA = join(root, "project-a");
    const projectASubdir = join(projectA, "packages", "one");
    const projectB = join(root, "project-b");
    const nestedRepo = join(projectA, "vendor", "nested");
    const outsideGit = join(root, "outside-git");
    mkdirSync(join(projectA, ".git"), { recursive: true });
    mkdirSync(projectASubdir, { recursive: true });
    mkdirSync(nestedRepo, { recursive: true });
    mkdirSync(join(nestedRepo, ".git"));
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectB, ".git"), "gitdir: ../worktrees/project-b\n");
    mkdirSync(outsideGit, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settings = join(agentDir, "settings.json");
    writeFileSync(settings, '{"defaultThinkingLevel":"high"}\n');

    assert.equal(resolveWorkflowProjectRoot(projectASubdir), resolveWorkflowProjectRoot(projectA));
    assert.equal(resolveWorkflowProjectRoot(nestedRepo), realpathSync(nestedRepo));
    assert.equal(resolveWorkflowProjectRoot(projectB), realpathSync(projectB));
    assert.equal(resolveWorkflowProjectRoot(outsideGit), realpathSync(outsideGit));
    assert.notEqual(workflowPresetPath(projectA, agentDir), workflowPresetPath(projectB, agentDir));
    assert.notEqual(workflowPresetPath(projectA, agentDir), workflowPresetPath(nestedRepo, agentDir));
    assert.equal(readPersistedWorkflowPreset(projectA, agentDir), undefined);
    persistWorkflowPreset("optimal", projectASubdir, agentDir);
    persistWorkflowPreset("economical", projectB, agentDir);
    assert.equal(readPersistedWorkflowPreset(projectA, agentDir), "optimal");
    assert.equal(readPersistedWorkflowPreset(projectASubdir, agentDir), "optimal");
    assert.equal(readPersistedWorkflowPreset(projectB, agentDir), "economical");
    assert.equal(getWorkflowPresetPolicyForSpawn(projectASubdir), "optimal");
    assert.equal(getWorkflowPresetPolicyForSpawn(projectB), "economical");
    const workerA = subagentTest.prepareAgentLaunchProfile(
      { agent: "worker", task: "A" },
      { name: "worker", disableModelInvocation: false, model: "role/default", tools: "read" } as any,
      getWorkflowPresetPolicyForSpawn(projectASubdir),
    );
    const workerB = subagentTest.prepareAgentLaunchProfile(
      { agent: "worker", task: "B" },
      { name: "worker", disableModelInvocation: false, model: "role/default", tools: "read" } as any,
      getWorkflowPresetPolicyForSpawn(projectB),
    );
    assert.equal(workerA.loadout.model, "openai-codex/gpt-5.6-sol");
    assert.equal(workerB.loadout.model, "openai-codex/gpt-5.6-terra");
    assert.equal(readFileSync(settings, "utf8"), '{"defaultThinkingLevel":"high"}\n');
    assert.deepEqual(JSON.parse(readFileSync(workflowPresetPath(projectA, agentDir), "utf8")), {
      version: 1,
      projectRoot: resolveWorkflowProjectRoot(projectA),
      preset: "optimal",
    });
  });

  it("rejects an unavailable model before changing main state", async () => {
    const harness = createPresetHarness({ available: [model("openai-codex", "gpt-5.6-sol")] });
    let saved = false;
    const result = await applyWorkflowPreset(harness.pi, harness.ctx, "optimal", {
      save() { saved = true; },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /gpt-5\.6-luna/);
    assert.deepEqual(harness.setModels, []);
    assert.equal(harness.state.thinking, "high");
    assert.equal(saved, false);
  });

  it("rolls back exact main state on clamping and save failure and discloses rollback failure", async () => {
    const clamped = createPresetHarness({ clampThinking: "low" });
    const clampedResult = await applyWorkflowPreset(clamped.pi, clamped.ctx, "optimal");
    assert.equal(clampedResult.ok, false);
    assert.match(clampedResult.ok ? "" : clampedResult.message, /not applied exactly/);
    assert.equal(clamped.state.model.id, "original");
    assert.equal(clamped.state.thinking, "high");

    const saveFailure = createPresetHarness();
    const failedSave = await applyWorkflowPreset(saveFailure.pi, saveFailure.ctx, "economical", {
      save() { throw new Error("disk full"); },
    });
    assert.equal(failedSave.ok, false);
    assert.match(failedSave.ok ? "" : failedSave.message, /disk full/);
    assert.equal(saveFailure.state.model.id, "original");
    assert.equal(saveFailure.state.thinking, "high");

    const failedRollback = createPresetHarness({ rejectRollback: true });
    const result = await applyWorkflowPreset(failedRollback.pi, failedRollback.ctx, "maximum", {
      save() { throw new Error("read-only"); },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /Rollback also failed for: main model/);
  });
});

describe("installed Pi workflow command", { concurrency: 1 }, () => {
  it("changes main model and effort, survives a model-free restart, and preserves settings defaults", async () => {
    const root = temporaryDir("workflow-installed-");
    const agentDir = join(root, "agent");
    const cwd = join(root, "project-a");
    const otherCwd = join(root, "project-b");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(join(otherCwd, ".git"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_ID;
    delete process.env[WORKFLOW_PRESET_ENV];

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "fixture-account",
    }));
    const modelRuntime = await ModelRuntime.create({
      credentials,
      allowModelNetwork: false,
      modelsStorePath: join(root, "models-store.json"),
      modelsPath: join(root, "models.json"),
    });
    const initial = modelRuntime.getModel("openai-codex", "gpt-5.6-terra");
    assert.ok(initial);

    async function createSession(projectCwd = cwd) {
      const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "high" });
      const loader = new DefaultResourceLoader({
        cwd: projectCwd,
        agentDir,
        settingsManager,
        extensionFactories: [subagentsExtension],
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd: projectCwd,
        agentDir,
        model: initial,
        thinkingLevel: "high",
        modelRuntime,
        settingsManager,
        sessionManager: SessionManager.inMemory(projectCwd),
        resourceLoader: loader,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      await created.session.bindExtensions({ mode: "print" });
      return { ...created, settingsManager };
    }

    const first = await createSession();
    try {
      const originalTools = first.session.agent.state.tools.map((tool) => tool.name);
      await first.session.prompt("/preset maximum");
      assert.equal(first.session.model?.id, "gpt-6-astra");
      assert.equal(first.session.thinkingLevel, "xhigh");
      assert.equal(readPersistedWorkflowPreset(cwd, agentDir), "maximum");
      assert.deepEqual(first.session.agent.state.tools.map((tool) => tool.name), originalTools);
      await first.session.prompt("/preset optimal");
      assert.equal(first.session.model?.provider, "openai-codex");
      assert.equal(first.session.model?.id, "gpt-5.6-sol");
      assert.equal(first.session.thinkingLevel, "medium");
      assert.equal(readPersistedWorkflowPreset(cwd, agentDir), "optimal");
      assert.equal(first.settingsManager.getDefaultThinkingLevel(), "high");
      assert.equal(getWorkflowPresetPolicyForSpawn(cwd), "optimal");
      assert.equal(getWorkflowPresetPolicyForSpawn(otherCwd), "off");
      assert.deepEqual(first.session.agent.state.tools.map((tool) => tool.name), originalTools);
    } finally {
      first.session.dispose();
    }

    __test__.setActiveTopLevelPolicy(undefined);
    const otherProject = await createSession(otherCwd);
    try {
      await otherProject.session.prompt("/preset economical");
      assert.equal(otherProject.session.model?.id, "gpt-5.6-terra");
      assert.equal(otherProject.session.thinkingLevel, "medium");
      assert.equal(readPersistedWorkflowPreset(otherCwd, agentDir), "economical");
      assert.equal(readPersistedWorkflowPreset(cwd, agentDir), "optimal");
    } finally {
      otherProject.session.dispose();
    }

    __test__.setActiveTopLevelPolicy(undefined);
    const restarted = await createSession(cwd);
    try {
      assert.equal(restarted.session.model?.id, "gpt-5.6-sol");
      assert.equal(restarted.session.thinkingLevel, "medium");
      assert.equal(restarted.settingsManager.getDefaultThinkingLevel(), "high");
      await restarted.session.prompt("/preset off");
      assert.equal(restarted.session.model?.id, "gpt-5.6-sol");
      assert.equal(restarted.session.thinkingLevel, "medium");
      assert.equal(existsSync(workflowPresetPath(cwd, agentDir)), false);
      assert.equal(readPersistedWorkflowPreset(otherCwd, agentDir), "economical");
    } finally {
      restarted.session.dispose();
    }
  });

  it("supports autocomplete and leaves picker cancellation unchanged", async () => {
    const root = temporaryDir("workflow-command-");
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_SUBAGENT_ID;
    const commands = new Map<string, any>();
    installWorkflowPresetExtension({
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on() {},
    } as any);
    const command = commands.get("preset");
    assert.deepEqual(
      command.getArgumentCompletions("o").map((item: any) => item.value),
      ["optimal", "off"],
    );
    let waits = 0;
    const notices: any[] = [];
    await command.handler("", {
      hasUI: true,
      ui: {
        async select() { return undefined; },
        notify(message: string, level: string) { notices.push({ message, level }); },
      },
      async waitForIdle() { waits++; },
    });
    assert.equal(waits, 0);
    assert.deepEqual(notices, []);
    assert.equal(existsSync(workflowPresetPath(root, root)), false);
  });

  it("does not register a mutating selector inside a child", () => {
    process.env.PI_SUBAGENT_ID = "child";
    process.env[WORKFLOW_PRESET_ENV] = "maximum";
    let commands = 0;
    let handlers = 0;
    installWorkflowPresetExtension({
      registerCommand() { commands++; },
      on() { handlers++; },
    } as any);
    assert.equal(commands, 0);
    assert.equal(handlers, 0);
  });
});
