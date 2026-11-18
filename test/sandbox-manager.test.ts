import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig, type SandboxConfig } from "../src/config.js";
import type { DockerRunner } from "../src/docker.js";
import { SandboxManager } from "../src/sandbox-manager.js";

class FakeDocker implements DockerRunner {
  calls: string[][] = [];
  failStart = false;
  createOutput = "a".repeat(64);
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[0] === "create") return this.createOutput;
    if (args[0] === "start" && this.failStart) throw new Error("start failed");
    if (args[0] === "inspect") return "running";
    if (args[0] === "exec") return "v22.0.0";
    return "";
  }
}

async function fixture(): Promise<{ config: SandboxConfig; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "chh-test-"));
  return {
    config: {
      workspaceRoot: join(directory, "sandboxes"),
      profiles: {
        coder: { image: "node:22-alpine", cpus: 2, memory: "2g", pidsLimit: 128, network: "none", workspaceReadOnly: false },
        reviewer: { image: "node:22-alpine", cpus: 1, memory: "1g", pidsLimit: 96, network: "none", workspaceReadOnly: true }
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("creates an isolated coder sandbox and cleans it up", async (t) => {
  const { config, cleanup } = await fixture();
  t.after(cleanup);
  const docker = new FakeDocker();
  const manager = new SandboxManager(config, docker);
  const sandbox = await manager.create("coder", {
    prepareWorkspace: async (dir) => writeFile(join(dir, "task.txt"), "hello")
  });
  assert.equal(await readFile(join(sandbox.workspace, "task.txt"), "utf8"), "hello");
  const create = docker.calls[0];
  assert.equal(create[0], "create");
  for (const flag of ["--network", "--cap-drop", "--security-opt", "--read-only", "--pids-limit", "--cpus", "--memory", "--user", "--mount"]) {
    assert.ok(create.includes(flag), `missing ${flag}`);
  }
  assert.equal(create[create.indexOf("--network") + 1], "none");
  assert.equal(create[create.indexOf("--cap-drop") + 1], "ALL");
  assert.match(create[create.indexOf("--mount") + 1], /target=\/workspace$/);
  assert.equal(await manager.exec(sandbox, ["node", "--version"]), "v22.0.0");
  assert.equal(await manager.status(sandbox), "running");
  await manager.destroy(sandbox);
  assert.equal(docker.calls.at(-1)?.[0], "rm");
  await assert.rejects(readFile(join(sandbox.workspace, "task.txt")));
});

test("reviewer has a read-only bind mount", async (t) => {
  const { config, cleanup } = await fixture();
  t.after(cleanup);
  const docker = new FakeDocker();
  const manager = new SandboxManager(config, docker);
  await manager.withSandbox("reviewer", async () => {
    assert.match(docker.calls[0].find((x) => x.startsWith("type=bind")) ?? "", /,readonly$/);
  });
});

test("failed start removes the container and workspace", async (t) => {
  const { config, cleanup } = await fixture();
  t.after(cleanup);
  const docker = new FakeDocker();
  docker.failStart = true;
  const manager = new SandboxManager(config, docker);
  await assert.rejects(manager.create("coder"), /start failed/);
  assert.equal(docker.calls.at(-1)?.[0], "rm");
});

test("invalid Docker ID rolls back using the generated container name", async (t) => {
  const { config, cleanup } = await fixture();
  t.after(cleanup);
  const docker = new FakeDocker();
  docker.createOutput = "invalid container ID";
  const manager = new SandboxManager(config, docker);

  await assert.rejects(manager.create("coder"), /Docker returned an invalid container ID/);
  const create = docker.calls[0];
  const name = create[create.indexOf("--name") + 1];
  assert.match(name, /^chh-/);
  assert.deepEqual(docker.calls.slice(1), [["rm", "-f", name]]);
  assert.deepEqual(await readdir(config.workspaceRoot), []);
});

test("configuration rejects unrestricted networking", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chh-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "config.json");
  await writeFile(filename, JSON.stringify({
    version: 1,
    workspaceRoot: "./sandboxes",
    profiles: {
      coder: { image: "node:22-alpine", cpus: 1, memory: "1g", pidsLimit: 64, network: "bridge", workspaceReadOnly: false }
    }
  }));
  await assert.rejects(loadSandboxConfig(filename), /Network access is not yet supported/);
});
