import { resolve } from "node:path";
import { loadSandboxConfig } from "./config.js";
import { DockerCli } from "./docker.js";
import { SandboxManager } from "./sandbox-manager.js";
import { SessionSandboxRegistry } from "./session-registry.js";

async function main(): Promise<void> {
  const [command, action, argument] = process.argv.slice(2);
  const docker = new DockerCli();
  const config = await loadSandboxConfig(resolve("sandboxes.config.json"));
  const manager = new SandboxManager(config, docker);
  const registry = new SessionSandboxRegistry(config, manager, docker);

  if (command === "image" && action === "build") {
    console.log("Building local Codex image...");
    console.log(await docker.run(["build", "-f", "images/codex.Dockerfile", "-t", "chh-codex:local", "."]));
    return;
  }

  if (command === "doctor") {
    console.log("Sandbox Manager diagnostics");
    const version = await docker.run(["version", "--format", "{{.Server.Version}}"]);
    console.log("Docker server: " + version);
    for (const [profile, options] of Object.entries(config.profiles)) {
      try {
        const image = await docker.run(["image", "inspect", "--format", "{{.Id}}", options.image]);
        console.log(profile + ": image ready (" + image.slice(0, 24) + ")");
      } catch {
        console.log(profile + ": image missing (" + options.image + "). Run npm run sandbox:setup.");
      }
      console.log(profile + ": network=" + options.network + ", memory=" + options.memory);
    }
    console.log("Agent executor connection: not implemented yet");
    return;
  }

  if (command === "smoke" || (command === "sandbox" && action === "smoke")) {
    const profile = command === "smoke" ? (action ?? "coder") : (argument ?? "coder");
    await manager.withSandbox(profile, async (sandbox) => {
      console.log("Started " + profile + " sandbox " + sandbox.id.slice(0, 12));
      console.log("Workspace: " + sandbox.workspace);
      console.log("Docker state: " + await manager.status(sandbox));
      console.log("Node: " + await manager.exec(sandbox, ["node", "--version"]));
    });
    console.log("Sandbox container and workspace removed");
    return;
  }

  if (command === "sandbox" && action === "list") {
    const records = await registry.list();
    if (!records.length) {
      console.log("No registered session sandboxes");
      return;
    }
    for (const record of records) {
      console.log(record.binding.sessionId + "  " + record.binding.environmentId + "  " +
        record.sandbox.profile + "  docker=" + record.containerStatus + "  id=" + record.sandbox.id.slice(0, 12));
    }
    return;
  }

  if (command === "sandbox" && action === "logs" && argument) {
    const record = await registry.get(argument);
    if (!record) throw new Error("No sandbox is registered for that environment ID");
    console.log(await manager.logs(record.sandbox));
    return;
  }

  if (command === "sandbox" && action === "cleanup" && argument) {
    const removed = await registry.release(argument);
    console.log(removed ? "Sandbox and registry record removed" : "No registered sandbox for that environment ID");
    return;
  }

  throw new Error("Usage: chh doctor | image build | sandbox smoke [coder|reviewer] | sandbox list | sandbox logs <environment-id> | sandbox cleanup <environment-id>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
