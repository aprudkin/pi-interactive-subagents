import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type WorkflowPresetId = "maximum" | "optimal" | "economical";
export type WorkflowPresetPolicy = WorkflowPresetId | "off";
export type WorkflowThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface WorkflowModelTarget {
  provider: "openai-codex";
  model: string;
  thinking: WorkflowThinkingLevel;
}

export type WorkflowPresetRole = "worker" | "reviewer" | "scout" | "researcher";

export interface WorkflowPreset {
  main: WorkflowModelTarget;
  children: Readonly<Record<WorkflowPresetRole, WorkflowModelTarget>>;
}

const codex = (model: string, thinking: WorkflowThinkingLevel): WorkflowModelTarget => ({
  provider: "openai-codex",
  model,
  thinking,
});

export const WORKFLOW_PRESETS: Readonly<Record<WorkflowPresetId, WorkflowPreset>> = {
  maximum: {
    main: codex("gpt-6-astra", "xhigh"),
    children: {
      worker: codex("gpt-6-astra", "xhigh"),
      reviewer: codex("gpt-6-astra", "xhigh"),
      researcher: codex("gpt-6-astra", "high"),
      scout: codex("gpt-6-astra", "low"),
    },
  },
  optimal: {
    main: codex("gpt-5.6-sol", "medium"),
    children: {
      worker: codex("gpt-5.6-sol", "medium"),
      reviewer: codex("gpt-5.6-sol", "high"),
      researcher: codex("gpt-5.6-sol", "medium"),
      scout: codex("gpt-5.6-luna", "low"),
    },
  },
  economical: {
    main: codex("gpt-5.6-terra", "medium"),
    children: {
      worker: codex("gpt-5.6-terra", "medium"),
      reviewer: codex("gpt-5.6-terra", "high"),
      researcher: codex("gpt-5.6-terra", "medium"),
      scout: codex("gpt-5.6-luna", "low"),
    },
  },
};

export const WORKFLOW_PRESET_ENV = "PI_SUBAGENT_WORKFLOW_PRESET";
const WORKFLOW_PRESET_DIR = "workflow-presets";
const PRESET_IDS = Object.keys(WORKFLOW_PRESETS) as WorkflowPresetId[];
const PRESET_ROLES = ["worker", "reviewer", "scout", "researcher"] as const;

let activeTopLevelPolicy: WorkflowPresetPolicy | undefined;
let activeProjectRoot: string | undefined;
let activationError: string | undefined;

export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function isWorkflowPresetId(value: unknown): value is WorkflowPresetId {
  return typeof value === "string" && Object.hasOwn(WORKFLOW_PRESETS, value);
}

export function isWorkflowPresetPolicy(value: unknown): value is WorkflowPresetPolicy {
  return value === "off" || isWorkflowPresetId(value);
}

/** Resolve subdirectories to their nearest checkout/worktree root; outside Git, use canonical cwd. */
export function resolveWorkflowProjectRoot(cwd: string): string {
  const canonicalCwd = realpathSync(cwd);
  let current = canonicalCwd;
  for (;;) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      try {
        const kind = statSync(marker);
        if (kind.isDirectory() || kind.isFile()) return current;
      } catch {}
    }
    const parent = dirname(current);
    if (parent === current) return canonicalCwd;
    current = parent;
  }
}

export function workflowPresetPath(cwd: string, agentDir = getAgentConfigDir()): string {
  const projectRoot = resolveWorkflowProjectRoot(cwd);
  const key = createHash("sha256").update(projectRoot).digest("hex");
  return join(agentDir, WORKFLOW_PRESET_DIR, `${key}.json`);
}

export function readPersistedWorkflowPreset(
  cwd: string,
  agentDir = getAgentConfigDir(),
): WorkflowPresetId | undefined {
  const projectRoot = resolveWorkflowProjectRoot(cwd);
  const path = workflowPresetPath(projectRoot, agentDir);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    version?: unknown;
    projectRoot?: unknown;
    preset?: unknown;
  };
  if (
    parsed.version !== 1 ||
    parsed.projectRoot !== projectRoot ||
    !isWorkflowPresetId(parsed.preset)
  ) {
    throw new Error(`Invalid project workflow preset file: ${path}`);
  }
  return parsed.preset;
}

export function persistWorkflowPreset(
  id: WorkflowPresetId,
  cwd: string,
  agentDir = getAgentConfigDir(),
): void {
  const projectRoot = resolveWorkflowProjectRoot(cwd);
  const path = workflowPresetPath(projectRoot, agentDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, projectRoot, preset: id }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

export function clearPersistedWorkflowPreset(
  cwd: string,
  agentDir = getAgentConfigDir(),
): void {
  try {
    unlinkSync(workflowPresetPath(cwd, agentDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** The active policy for status/UI, or the inherited origin policy in a child. */
export function getWorkflowPresetPolicy(): WorkflowPresetPolicy | undefined {
  if (process.env.PI_SUBAGENT_ID) {
    const inherited = process.env[WORKFLOW_PRESET_ENV];
    return isWorkflowPresetPolicy(inherited) ? inherited : undefined;
  }
  return activeTopLevelPolicy;
}

/** Fresh top-level spawns read the current project choice; nested spawns keep origin policy. */
export function getWorkflowPresetPolicyForSpawn(cwd: string): WorkflowPresetPolicy {
  if (process.env.PI_SUBAGENT_ID) return getWorkflowPresetPolicy() ?? "off";
  return readPersistedWorkflowPreset(cwd) ?? "off";
}

export function resolveFreshSubagentProfile(params: {
  role: string;
  explicitModel?: string;
  defaultModel?: string;
  defaultThinking?: string;
  policy?: WorkflowPresetPolicy;
}): { model: string | null; thinking: string | null; policy: WorkflowPresetPolicy | undefined } {
  const policy = params.policy ?? getWorkflowPresetPolicy();
  const target = policy && policy !== "off" && PRESET_ROLES.includes(params.role as WorkflowPresetRole)
    ? WORKFLOW_PRESETS[policy].children[params.role as WorkflowPresetRole]
    : undefined;
  return {
    model: params.explicitModel ?? (target ? `${target.provider}/${target.model}` : params.defaultModel) ?? null,
    thinking: params.explicitModel
      ? params.defaultThinking ?? null
      : target?.thinking ?? params.defaultThinking ?? null,
    policy,
  };
}

function formatTarget(target: WorkflowModelTarget): string {
  return `${target.provider}/${target.model}:${target.thinking}`;
}

function formatStatus(projectChoice: WorkflowPresetId | undefined, ctx: ExtensionContext): string {
  const effectiveMain = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}:${ctx.thinkingLevel ?? "unknown"}`
    : "unavailable";
  const lines = [
    `Project: ${activeProjectRoot ?? resolveWorkflowProjectRoot(ctx.cwd)}`,
    `Project preset: ${projectChoice ?? "off"}`,
    `Effective main: ${effectiveMain}`,
  ];
  if (activationError) lines.push(`Application error: ${activationError}`);
  const policy = projectChoice ?? "off";
  if (policy === "off") {
    lines.push(
      "Fresh children: role defaults (explicit model overrides still win)",
      "Existing and resumed children keep their pinned loadouts.",
    );
    return lines.join("\n");
  }
  const preset = WORKFLOW_PRESETS[policy];
  lines.push(
    "Fresh child mapping:",
    ...PRESET_ROLES.map((role) => `  ${role}: ${formatTarget(preset.children[role])}`),
    "Explicit child model overrides win; existing and resumed children keep their pinned loadouts.",
  );
  return lines.join("\n");
}

function modelMatches(model: ExtensionContext["model"], target: WorkflowModelTarget): boolean {
  return model?.provider === target.provider && model.id === target.model;
}

function unavailablePresetModels(ctx: ExtensionContext, id: WorkflowPresetId): WorkflowModelTarget[] {
  const preset = WORKFLOW_PRESETS[id];
  const available = ctx.modelRegistry.getAvailable();
  const required = [preset.main, ...Object.values(preset.children)];
  return [...new Map(required.map((target) => [`${target.provider}/${target.model}`, target])).values()]
    .filter((target) => !available.some((model) => model.provider === target.provider && model.id === target.model));
}

async function rollbackMainState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  originalModel: NonNullable<ExtensionContext["model"]>,
  originalThinking: WorkflowThinkingLevel,
): Promise<string[]> {
  const failures: string[] = [];
  try {
    const restored = await pi.setModel(originalModel);
    if (!restored || ctx.model?.provider !== originalModel.provider || ctx.model.id !== originalModel.id) {
      failures.push("main model");
    }
  } catch {
    failures.push("main model");
  }
  try {
    pi.setThinkingLevel(originalThinking);
    if (pi.getThinkingLevel() !== originalThinking) failures.push("thinking level");
  } catch {
    failures.push("thinking level");
  }
  return failures;
}

export async function applyWorkflowPreset(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  id: WorkflowPresetId,
  options: { save?: (id: WorkflowPresetId) => void } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const missing = unavailablePresetModels(ctx, id);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Preset "${id}" was not applied. Unavailable authenticated model(s): ${missing.map((target) => `${target.provider}/${target.model}`).join(", ")}.`,
    };
  }
  if (!ctx.model) {
    return { ok: false, message: `Preset "${id}" was not applied: the current main model cannot be snapshotted for rollback.` };
  }

  const preset = WORKFLOW_PRESETS[id];
  const available = ctx.modelRegistry.getAvailable();
  const originalModel = ctx.model;
  const originalThinking = pi.getThinkingLevel() as WorkflowThinkingLevel;
  const mainModel = available.find((model) => model.provider === preset.main.provider && model.id === preset.main.model)!;
  let failure: string | undefined;
  try {
    const switched = await pi.setModel(mainModel);
    if (!switched || !modelMatches(ctx.model, preset.main)) {
      failure = "the main model switch failed or did not take effect exactly";
      throw new Error(failure);
    }
    pi.setThinkingLevel(preset.main.thinking);
    if (pi.getThinkingLevel() !== preset.main.thinking || ctx.thinkingLevel !== preset.main.thinking) {
      failure = `the requested thinking level ${preset.main.thinking} was not applied exactly`;
      throw new Error(failure);
    }
    options.save?.(id);
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
    const rollbackFailures = await rollbackMainState(pi, ctx, originalModel, originalThinking);
    return {
      ok: false,
      message:
        `Preset "${id}" was not applied: ${failure}. ` +
        (rollbackFailures.length === 0
          ? "The previous main model and thinking level were restored."
          : `Rollback also failed for: ${rollbackFailures.join(", ")}.`),
    };
  }
  return { ok: true };
}

async function choosePreset(ctx: ExtensionCommandContext): Promise<WorkflowPresetPolicy | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Use /preset maximum|optimal|economical|status|off in this mode.", "warning");
    return undefined;
  }
  const selected = await ctx.ui.select("Select workflow preset", [
    "maximum",
    "optimal",
    "economical",
    "off",
  ]);
  return isWorkflowPresetPolicy(selected) ? selected : undefined;
}

function updatePresetStatus(ctx: ExtensionContext): void {
  if (typeof ctx.ui.setStatus === "function") {
    ctx.ui.setStatus(
      "workflow-preset",
      activeTopLevelPolicy && activeTopLevelPolicy !== "off"
        ? `preset:${activeTopLevelPolicy}`
        : undefined,
    );
  }
}

function setActivePolicy(
  policy: WorkflowPresetPolicy | undefined,
  projectRoot: string,
  error?: string,
): void {
  activeTopLevelPolicy = policy;
  activeProjectRoot = projectRoot;
  activationError = error;
}

export function installWorkflowPresetExtension(pi: ExtensionAPI): void {
  // Restricted children inherit their origin project's policy through the launch environment.
  // They must neither reconfigure their pinned model nor mutate project selection.
  if (process.env.PI_SUBAGENT_ID) return;

  pi.registerCommand("preset", {
    description: "Select a project workflow model preset for the main session and fresh subagents",
    getArgumentCompletions(prefix) {
      const items = [...PRESET_IDS, "status", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested === "status") {
        try {
          ctx.ui.notify(formatStatus(readPersistedWorkflowPreset(ctx.cwd), ctx), "info");
        } catch (error) {
          ctx.ui.notify(
            `Project workflow preset could not be read: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }

      const selection = requested || await choosePreset(ctx);
      if (!selection) return;
      if (!isWorkflowPresetPolicy(selection)) {
        ctx.ui.notify(
          `Unknown preset "${selection}". Use maximum, optimal, economical, status, or off.`,
          "error",
        );
        return;
      }

      await ctx.waitForIdle();
      const projectRoot = resolveWorkflowProjectRoot(ctx.cwd);
      if (selection === "off") {
        try {
          clearPersistedWorkflowPreset(ctx.cwd);
        } catch (error) {
          ctx.ui.notify(
            `Preset was not turned off because the project selection could not be cleared: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
        setActivePolicy("off", projectRoot);
        updatePresetStatus(ctx);
        ctx.ui.notify(
          "This project's workflow preset is off. The current main model was left unchanged; future fresh children use role defaults.",
          "info",
        );
        return;
      }

      const result = await applyWorkflowPreset(pi, ctx, selection, {
        save(id) { persistWorkflowPreset(id, ctx.cwd); },
      });
      if (!result.ok) {
        ctx.ui.notify(result.message, "error");
        return;
      }
      setActivePolicy(selection, projectRoot);
      updatePresetStatus(ctx);
      ctx.ui.notify(`Workflow preset "${selection}" applied and saved for this project.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const projectRoot = resolveWorkflowProjectRoot(ctx.cwd);
    let saved: WorkflowPresetId | undefined;
    try {
      saved = readPersistedWorkflowPreset(ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivePolicy(undefined, projectRoot, message);
      ctx.ui.notify(`Project workflow preset could not be read and was not applied: ${message}`, "error");
      updatePresetStatus(ctx);
      return;
    }
    if (!saved) {
      setActivePolicy("off", projectRoot);
      updatePresetStatus(ctx);
      return;
    }

    const result = await applyWorkflowPreset(pi, ctx, saved);
    if (!result.ok) {
      setActivePolicy(undefined, projectRoot, result.message);
      ctx.ui.notify(`Saved project ${result.message}`, "error");
      updatePresetStatus(ctx);
      return;
    }
    setActivePolicy(saved, projectRoot);
    updatePresetStatus(ctx);
  });
}

export const __test__ = {
  formatStatus,
  setActiveTopLevelPolicy(policy: WorkflowPresetPolicy | undefined) {
    activeTopLevelPolicy = policy;
    activeProjectRoot = undefined;
    activationError = undefined;
  },
  getActiveState() {
    return { activeTopLevelPolicy, activeProjectRoot, activationError };
  },
};
