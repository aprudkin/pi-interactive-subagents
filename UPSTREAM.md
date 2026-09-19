# Upstream attribution

This package is a local adaptation of
[`amosblomqvist/pi-interactive-subagents`](https://github.com/amosblomqvist/pi-interactive-subagents)
version 3.7.2 at commit `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`.
That project is itself a tmux-only fork of
[`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents).

The upstream MIT license is preserved in [`UPSTREAM-LICENSE`](UPSTREAM-LICENSE).

## Downstream status

This repository is an independently maintained downstream fork. It is not automatically synchronized with upstream, and its releases follow their own versioning after the reviewed 3.7.2 base.

## Material local changes

- Use the `@earendil-works` Pi packages and current TypeBox package, targeting Pi 0.85.1 and Node.js 22.19.0 or newer.
- Support tmux only, remove the inherited Claude plugin and stop-hook payload, and reject alternate CLI profiles before allocating sockets or panes.
- Replace live-pane keyboard injection with an authenticated, per-run Unix socket and exact child-side `sendUserMessage` delivery.
- Use a dedicated supervisor, process groups, identity-bound completion records, and process-exit sidecars instead of terminal text sentinels.
- Detect missing or identity-mismatched tmux panes as explicit recoverable failures and roll back only resources owned by the current launch transaction.
- Wait for Pi's `agent_settled` event before autonomous shutdown; preserve waiting children and in-flight nested subagents.
- Persist sandboxed schema-versioned loadout snapshots so named resumes replay the original tool allowlist, backing extensions, model, prompt, cwd, and child-spawn restrictions.
- Add orchestrator-mediated `ask_question`, nested subagent routing, and strict whitelist-only child tool loading.
- Keep the parent pane on the left and rebalance only owned subagent panes in a deterministic right-side stack.
- Resolve a removed parent Node executable through a bounded compatible PATH fallback before child startup.
- Add project-scoped workflow presets for main and standard-role model/reasoning routing without changing role permissions or verification policy.
- Publish versioned in-process lifecycle snapshots for status integrations without terminal polling.
