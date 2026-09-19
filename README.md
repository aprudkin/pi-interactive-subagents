# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**Maintained tmux-only downstream fork.** Based on amosblomqvist/pi-interactive-subagents 3.7.2; see [upstream provenance and local changes](UPSTREAM.md). This repository is independently maintained and is not automatically synchronized with upstream. Alternate CLIs, including `cli: claude`, are unsupported.

## Install

Pi packages execute with full system access. Review the [repository source](https://github.com/aprudkin/pi-interactive-subagents) before installation: this extension starts processes, controls tmux panes, and loads configured tools with the user's permissions.

Install the pinned release globally:

```sh
pi install git:github.com/aprudkin/pi-interactive-subagents@v4.0.0
```

Start a fresh Pi process inside tmux after installation. See [Requirements](#requirements) for supported versions. Do not install this fork alongside another `pi-interactive-subagents` package because both register the same tools and command.

To try the package temporarily for the current Pi run without adding it to settings, use the following command. This still executes the extension with full system access:

```sh
pi -e git:github.com/aprudkin/pi-interactive-subagents@v4.0.0
```

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

The parent Pi pane stays full-height on the left and receives half of the available width (including the spare cell when rounding). Subagent panes share the right half in an equal top-to-bottom stack. The extension rebalances this owned pane group immediately after spawns and managed closes, and checks every 500 ms for external pane closes and window resizes while children remain, without changing pane IDs, processes, or keyboard focus. Nested subagents join the same root stack. Unrelated manual panes are not passed through a window-wide tmux layout; if they share the window, their geometry is left alone.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the parent sends the exact message over a private, per-run authenticated Unix socket. The child extension invokes `pi.sendUserMessage` (`steer` while busy, immediate while idle). Pi 0.85.1 exposes no correlated queue-acceptance result, so even a confirmed child receipt is reported as **unknown delivery** and is never retried automatically.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, absolute backing-extension paths, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot without consulting current tool-extension registrations. This adaptation requires `schemaVersion: 2` and `runtime: "pi"` in the snapshot. Legacy, incomplete, or unrestricted snapshots cannot be resumed, and resume is refused if a persisted backing extension is no longer available; start a fresh subagent instead.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Workflow presets

`/preset` opens a selector for the main agent and fresh standard-role subagents. Direct commands support completion:

```text
/preset maximum
/preset optimal
/preset economical
/preset status
/preset off
```

The presets use the `openai-codex` provider. Each table cell specifies **model / reasoning effort**:

| Role | Maximum — quality first | Optimal — balanced depth | Economical — routine work |
| --- | --- | --- | --- |
| Main agent | `gpt-6-astra` / `xhigh` | `gpt-5.6-sol` / `medium` | `gpt-5.6-terra` / `medium` |
| Worker | `gpt-6-astra` / `xhigh` | `gpt-5.6-sol` / `medium` | `gpt-5.6-terra` / `medium` |
| Reviewer | `gpt-6-astra` / `xhigh` | `gpt-5.6-sol` / `high` | `gpt-5.6-terra` / `high` |
| Researcher | `gpt-6-astra` / `high` | `gpt-5.6-sol` / `medium` | `gpt-5.6-terra` / `medium` |
| Scout | `gpt-6-astra` / `low` | `gpt-5.6-luna` / `low` | `gpt-5.6-luna` / `low` |

### Why these models

[OpenAI's model-selection guidance](https://learn.chatgpt.com/docs/models), inspected on 2026-09-19, positions Astra for the hardest end-to-end work, Sol for complex and open-ended work, Terra for everyday reasoning and tool use, and Luna for clear, repeatable tasks. The exact IDs are also present in the installed Pi catalog and current Codex model metadata.

The matrix is a local task-fit policy, **not a measured ranking of these role prompts**. Maximum prioritizes capability at a higher expected resource cost; optimal reserves deeper reasoning for review and a smaller model for recon; economical uses Terra for general implementation, synthesis and judgment rather than assigning all work to Luna. A difficult task may still need a stronger preset.

OpenAI recommends the lowest reasoning effort that produces the needed result and notes that most tasks do not need Max or Ultra. Maximum therefore does not mean `max` everywhere. `max` remains a manual per-task escalation; Ultra's automatic delegation is not equivalent to a reasoning level and is not implemented by this selector. None of the presets disables verification or independent review.

[Codex pricing](https://developers.openai.com/codex/pricing) distinguishes ChatGPT plan allowances/credits from API-key billing. These presets keep `openai-codex`; they do not switch to the API-key `openai` provider. Cached Pi cost metadata is not an authoritative invoice or a promise of savings. Actual usage and latency depend on task size, context, reasoning and retries; no role-specific cost, quality or latency benchmark is claimed.

### Persistence and boundaries

- Preset defaults are saved **per project** as private runtime data in `~/.pi/agent/workflow-presets/<project-hash>.json` (or under `PI_CODING_AGENT_DIR` when configured), not in tracked project files. The canonical nearest Git checkout root identifies a project: subdirectories and symlink aliases share it; separate worktrees and nested repositories do not. Outside Git, the canonical working directory identifies the project. Installation alone leaves existing behavior unchanged.
- There is one saved choice per project, not a separate preset in each session's history. Selection changes the current idle main session and that project's saved choice. Top-level startup, reload, new-session creation and resume apply the project's choice; fresh top-level subagent launches use it too. Different projects are independent. Multiple sessions within one project have no separate isolation or synchronization mechanism. A manual model/reasoning change lasts until the next preset application or session-start event.
- Fresh `worker`, `reviewer`, `researcher` and `scout` launches use the preset; other custom roles retain their profiles. An explicit spawn-model override bypasses the preset model and effort for that child, keeping the role's configured effort. Role identity, tool allowlists, permissions and context-isolation rules remain unchanged.
- Already-running children are not interrupted. Resuming a named child replays its original model, effort and sandbox rather than changing it to the current preset. Nested fresh children inherit the originating preset policy, including when they use a different working directory or agent directory.
- `/preset status` reports the project's saved choice and effective main settings. `/preset off` clears this project's choice, returning future fresh-child routing to role defaults. Other projects are unaffected. Off leaves the current main model/effort unchanged; it is not a rollback of all manual settings or an instruction to stop children.
- Applying a preset checks its model bundle before switching; unavailable models are reported rather than silently substituted. Access still depends on account, client and rollout. Persistence or application failures must not be presented as successful selection.
- The selector does not edit `settings.json`, role Markdown files, prompts, active tools, themes, approval records or verification policy. It does not make a model request merely to select a preset.

For example, project A can use maximum while project B uses economical. Switching B to optimal changes neither A's main agent nor the preset used for A's new subagents. Each project restores its own saved choice after restart.

Start a new Pi process after updating this package. Do not reload a parent that still owns active children.

### Preset verification

`npm run check` from this package runs the typecheck, unit tests and isolated tmux integration tests. Preset tests cover all three model/effort bundles, project-root storage and different-project isolation, main-agent switching through the installed Pi runtime, restart, off, unchanged settings defaults/tools, unavailable models, rollback, nested routing and loadout preservation. Checks use disposable data and synthetic credentials; they do not establish live account access, physical picker interaction, model quality or actual subscription savings. Existing lifecycle integration tests exercise fake child processes, not live model requests.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict application-tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child. If omitted or blank, the child gets no application tools; the `ask_question` control tool remains available. |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | Alternate CLIs are unsupported by this local package. A profile with `cli: claude` is rejected before socket or pane allocation. |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down after Pi emits `agent_settled` — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

The parent extension also publishes versioned aggregate snapshots on Pi's
`pi.events` bus at `pi-interactive-subagents/lifecycle/v1/snapshot`; consumers
can request the current state through
`pi-interactive-subagents/lifecycle/v1/request`. Snapshots contain running run
IDs, result deliveries waiting for the parent agent to start, and the latest
queued result outcome. This is an in-process notification seam for status
extensions: children do not write terminal status, and consumers do not need to
poll child activity files. A pending-delivery token closes the idle gap between
a child exiting and the parent beginning the result-triggered turn.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Completion and recovery

Each launch and sandboxed resume has a unique run identity. The child records semantic completion only after Pi emits `agent_settled`. A dedicated supervisor records its own and the child process identity, owns the child's process group, and atomically records actual process exit. The parent uses those durable records instead of terminal text or the lifetime of the surrounding shell.

A missing pane, an identity-mismatched pane, a process crash, or an exit without a matching completion record is reported as an explicit recoverable failure. The extension never steers through tmux and never treats a pane existence check as proof that a message reached the intended Pi process.

Fresh and resumed runs keep separate preparation but share one launch transaction
and one completion watcher. Rollback owns the current run's socket, pane and
launch artifacts; only fresh launches own their new session/loadout files.
Resume preserves the existing session/loadout and extracts results only from
entries added since that resume began. A parent delivery exception does not
trigger a second completion send; an attempted send is not proof of queue acceptance.

### Node upgrades while Pi is running

Fresh launches and resumes resolve the supervisor's Node executable each time.
They keep the parent's `process.execPath` while it is an executable file. If an
upgrade removed it, they use the first executable `node` in the parent's explicit
PATH directories, preserving its absolute alias (including stable symlinks).
That fallback must report Node >=22.19.0 within a one-second probe; an invalid,
incompatible, or timed-out first candidate is not bypassed for a later one.
An unavailable runtime fails with an actionable error before launch-command
dispatch, rather than waiting for the supervisor startup timeout.

This does not change Homebrew, the payload's `pi` lookup, or already-running
processes. Existing Pi parents retain their loaded extension code; start a fresh
Pi process after its children finish to use an updated package. The check is not
an atomic guarantee against another runtime removal between selection and exec.

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) 0.85.1.
- Node.js 22.19.0 or newer.
- [tmux](https://github.com/tmux/tmux).

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

This downstream fork is based on [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents), which is itself derived from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). HazAT's project originated the subagent architecture, multi-multiplexer surface layer, and status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

Original downstream work is available under [LICENSE](LICENSE). The upstream MIT notice is preserved in [UPSTREAM-LICENSE](UPSTREAM-LICENSE).
