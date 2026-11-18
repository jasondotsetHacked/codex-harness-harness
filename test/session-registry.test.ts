import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxConfig } from "../src/config.js";
import type { DockerRunner } from "../src/docker.js";
import { SandboxManager } from "../src/sandbox-manager.js";
import { SessionSandboxRegistry } from "../src/session-registry.js";

class FakeDocker implements DockerRunner {
  calls: string[][] = [];
  running = false;
  removeFails = false;
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[0] === "ps") return this.running ? "a".repeat(64) : "";
    if (args[0] === "create") return "a".repeat(64);
    if (args[0] === "start") { this.running = true; return ""; }
    if (args[0] === "inspect") return this.running ? "running" : "exited";
    if (args[0] === "rm") {
      if (this.removeFails) throw new Error("Docker removal failed");
      this.running = false;
    }
    return "";
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chh-registry-"));
  const config: SandboxConfig = {
    workspaceRoot: join(root, "sandboxes"),
    profiles: {
      coder: { image: "node:22-alpine", cpus: 2, memory: "2g", pidsLimit: 128, network: "none", workspaceReadOnly: false }
    }
  };
  const docker = new FakeDocker();
  const manager = new SandboxManager(config, docker);
  return {
    registry: new SessionSandboxRegistry(config, manager, docker),
    manager, docker, root, cleanup: () => rm(root, { recursive: true, force: true })
  };
}

const binding = { sessionId: "session_123", environmentId: "env_456" };

test("reuses the running environment across calls and registry restarts", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const first = await f.registry.acquire("coder", binding);
  const second = await f.registry.acquire("coder", binding);
  assert.deepEqual(second, first);
  assert.equal(f.docker.calls.filter(x => x[0] === "create").length, 1);
  assert.equal((await f.registry.list())[0].containerStatus, "running");
  assert.ok(await stat(first.workspace));
  assert.equal(await f.registry.release(binding.environmentId), true);
  assert.equal((await f.registry.list()).length, 0);
  await assert.rejects(stat(first.workspace));
});

test("rejects a different session claiming an existing environment", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.registry.acquire("coder", binding);
  await assert.rejects(f.registry.acquire("coder", { ...binding, sessionId: "other" }), /different session/);
  assert.equal(f.docker.calls.filter(x => x[0] === "create").length, 1);
});

test("does not duplicate an environment when Docker health is unknown", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.registry.acquire("coder", binding);
  f.docker.running = false;
  await assert.rejects(f.registry.acquire("coder", binding), /not healthy/);
  assert.equal(f.docker.calls.filter(x => x[0] === "create").length, 1);
});

test("preserves workspace and registry when container removal fails", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const sandbox = await f.registry.acquire("coder", binding);
  await writeFile(join(sandbox.workspace, "important.txt"), "keep");
  f.docker.removeFails = true;
  await assert.rejects(f.registry.release(binding.environmentId), /Docker removal failed/);
  assert.equal(await readFile(join(sandbox.workspace, "important.txt"), "utf8"), "keep");
  assert.equal((await f.registry.list()).length, 1);
});
