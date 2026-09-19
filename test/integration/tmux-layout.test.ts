import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeSurface,
  createSurface,
  getSurfaceIdentity,
} from "../../pi-extension/subagents/tmux.ts";

const tmuxAvailable = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Geometry {
  id: string;
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  pid: number;
  active: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("fixture condition timed out");
}

if (!tmuxAvailable) {
  it("requires tmux for isolated layout tests", { skip: true }, () => undefined);
} else {
  describe("isolated tmux subagent layout", { concurrency: 1 }, () => {
    let dir: string;
    let socket: string;
    let oldTmux: string | undefined;
    let oldPane: string | undefined;
    let windowSequence = 0;

    function tmux(args: string[]): string {
      return execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
    }

    function panes(target: string): Geometry[] {
      const output = tmux([
        "list-panes",
        "-t",
        target,
        "-F",
        "#{pane_id}\t#{pane_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_pid}\t#{pane_active}",
      ]);
      if (!output) return [];
      return output.split("\n").map((line) => {
        const [id, index, left, top, width, height, pid, active] = line.split("\t");
        return {
          id,
          index: Number(index),
          left: Number(left),
          top: Number(top),
          width: Number(width),
          height: Number(height),
          pid: Number(pid),
          active: active === "1",
        };
      });
    }

    function newFixtureWindow(width = 121, height = 40): { target: string; root: string } {
      const name = `layout-${windowSequence++}`;
      const root = tmux([
        "new-window",
        "-d",
        "-t",
        "fixture:",
        "-n",
        name,
        "-P",
        "-F",
        "#{pane_id}",
      ]);
      const target = `fixture:${name}`;
      tmux(["resize-window", "-t", target, "-x", String(width), "-y", String(height)]);
      process.env.TMUX_PANE = root;
      return { target, root };
    }

    function assertManagedGeometry(
      target: string,
      rootId: string,
      childIds: string[],
      width: number,
      height: number,
    ): void {
      const byId = new Map(panes(target).map((pane) => [pane.id, pane]));
      const root = byId.get(rootId);
      assert.ok(root);
      assert.equal(root.left, 0);
      assert.equal(root.top, 0);
      assert.equal(root.width, Math.ceil((width - 1) / 2));
      assert.equal(root.height, height);

      const children = childIds.map((id) => byId.get(id)).filter((pane): pane is Geometry => !!pane);
      assert.equal(children.length, childIds.length);
      children.sort((a, b) => a.top - b.top);
      assert.ok(children.every((pane) => pane.left === root.width + 1));
      assert.ok(children.every((pane) => pane.width === width - root.width - 1));
      assert.ok(Math.max(...children.map((pane) => pane.height)) - Math.min(...children.map((pane) => pane.height)) <= 1);
      assert.equal(children[0].top, 0);
      for (let index = 1; index < children.length; index += 1) {
        assert.equal(children[index].top, children[index - 1].top + children[index - 1].height + 1);
      }
      const last = children.at(-1)!;
      assert.equal(last.top + last.height, height);
    }

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "subagent-layout-tmux-"));
      socket = join(dir, "tmux.sock");
      execFileSync("tmux", [
        "-S",
        socket,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "fixture",
        "-x",
        "121",
        "-y",
        "40",
      ]);
      tmux(["set-option", "-g", "pane-base-index", "7"]);
      const pid = tmux(["display-message", "-p", "#{pid}"]);
      oldTmux = process.env.TMUX;
      oldPane = process.env.TMUX_PANE;
      process.env.TMUX = `${socket},${pid},0`;
    });

    after(async () => {
      // Let the monitor forget every fixture root while TMUX still points at
      // the isolated server; never let a pending tick target the live server.
      for (const window of tmux(["list-windows", "-t", "fixture", "-F", "#{window_id}"]).split("\n").slice(1)) {
        tmux(["kill-window", "-t", window]);
      }
      await delay(600);
      try { tmux(["kill-server"]); } catch {}
      if (oldTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = oldTmux;
      if (oldPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = oldPane;
      rmSync(dir, { recursive: true, force: true });
    });

    it("keeps one, two, and multiple subagents in an equal right stack", () => {
      const { target, root } = newFixtureWindow();
      assert.equal(panes(target).find((pane) => pane.id === root)?.index, 7);

      const first = createSurface("first");
      const firstPid = getSurfaceIdentity(first).panePid;
      assertManagedGeometry(target, root, [first], 121, 40);

      const second = createSurface("second");
      assert.equal(getSurfaceIdentity(first).panePid, firstPid);
      assertManagedGeometry(target, root, [first, second], 121, 40);

      // Simulate a nested subagent spawn. The inherited ownership marker keeps
      // it in the same root-managed right stack rather than making a new column.
      process.env.TMUX_PANE = first;
      const nested = createSurface("nested");
      process.env.TMUX_PANE = root;
      const fourth = createSurface("fourth");
      assert.equal(getSurfaceIdentity(first).panePid, firstPid);
      assertManagedGeometry(target, root, [first, second, nested, fourth], 121, 40);
    });

    it("rebalances internal and external removals and restores the last pane", async () => {
      const { target, root } = newFixtureWindow(120, 41);
      const children = [
        createSurface("one"),
        createSurface("two"),
        createSurface("three"),
        createSurface("four"),
      ];
      assertManagedGeometry(target, root, children, 120, 41);

      closeSurface(children[1]);
      assertManagedGeometry(target, root, [children[0], children[2], children[3]], 120, 41);

      tmux(["kill-pane", "-t", children[0]]);
      await waitFor(() => {
        try {
          assertManagedGeometry(target, root, [children[2], children[3]], 120, 41);
          return true;
        } catch {
          return false;
        }
      });

      closeSurface(children[2]);
      assertManagedGeometry(target, root, [children[3]], 120, 41);
      tmux(["kill-pane", "-t", children[3]]);
      await waitFor(() => {
        const remaining = panes(target);
        return remaining.length === 1 && remaining[0].id === root && remaining[0].width === 120 && remaining[0].height === 41;
      });
    });

    it("tracks odd and even window resizes without restarting panes or changing focus", async () => {
      const { target, root } = newFixtureWindow(121, 40);
      const children = [createSurface("one"), createSurface("two"), createSurface("three")];
      const identities = new Map([root, ...children].map((id) => [id, getSurfaceIdentity(id).panePid]));
      assert.equal(panes(target).find((pane) => pane.active)?.id, root);

      for (const [width, height] of [[120, 40], [121, 41], [122, 42], [119, 39]]) {
        tmux(["resize-window", "-t", target, "-x", String(width), "-y", String(height)]);
        await waitFor(() => {
          try {
            assertManagedGeometry(target, root, children, width, height);
            return true;
          } catch {
            return false;
          }
        });
      }

      for (const [id, pid] of identities) assert.equal(getSurfaceIdentity(id).panePid, pid);
      assert.equal(panes(target).find((pane) => pane.active)?.id, root);
    });

    it("does not relay out unrelated manual panes in the same window", async () => {
      const { target, root } = newFixtureWindow(121, 40);
      const manual = tmux([
        "split-window",
        "-d",
        "-v",
        "-p",
        "30",
        "-t",
        root,
        "-P",
        "-F",
        "#{pane_id}",
      ]);
      const before = panes(target).find((pane) => pane.id === manual);
      assert.ok(before);

      createSurface("managed-with-manual-neighbor");
      await delay(450);
      const afterManual = panes(target).find((pane) => pane.id === manual);
      assert.ok(afterManual);
      assert.deepEqual(
        {
          id: afterManual.id,
          left: afterManual.left,
          top: afterManual.top,
          width: afterManual.width,
          height: afterManual.height,
          pid: afterManual.pid,
          active: afterManual.active,
        },
        {
          id: before.id,
          left: before.left,
          top: before.top,
          width: before.width,
          height: before.height,
          pid: before.pid,
          active: before.active,
        },
      );
      assert.equal(panes(target).find((pane) => pane.active)?.id, root);
    });
  });
}
