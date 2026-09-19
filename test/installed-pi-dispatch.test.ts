import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const loaderUrl = new URL("./core/extensions/loader.js", piEntry);

describe("installed Pi 0.85.1 dispatch semantics", () => {
  it("returns void while a later sendUserMessage failure is reported out of band", async () => {
    const { createExtensionRuntime, loadExtensionFromFactory } = await import(loaderUrl.href);
    const runtime = createExtensionRuntime();
    const runtimeErrors: string[] = [];
    runtime.sendUserMessage = () => {
      // Mirrors AgentSession's bound action: its asynchronous method is caught
      // and emitted separately, while the public extension API returns void.
      void Promise.reject(new Error("preflight rejected")).catch((error) => {
        runtimeErrors.push(error.message);
      });
    };

    let capturedApi: ExtensionAPI | undefined;
    const loadedExtension = await loadExtensionFromFactory(
      (pi: ExtensionAPI) => { capturedApi = pi; },
      process.cwd(),
      createEventBus(),
      runtime,
    );
    assert.ok(loadedExtension);
    assert.ok(capturedApi);

    const result = capturedApi.sendUserMessage("cannot prove acceptance", { deliverAs: "steer" });
    assert.equal(result, undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(runtimeErrors, ["preflight rejected"]);
  });
});
