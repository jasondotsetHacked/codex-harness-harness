import { resolve } from "node:path";
import { loadSandboxConfig } from "./config.js";
import { DockerCli } from "./docker.js";
import { SandboxManager } from "./sandbox-manager.js";

async function main(): Promise<void> {
  const [command, profile = "coder"] = process.argv.slice(2);
  if (command !== "smoke") {
    throw new Error("Usage: npm run sandbox:smoke -- [coder|reviewer]");
  }
  const config = await loadSandboxConfig(resolve("sandboxes.config.json"));
  const manager = new SandboxManager(config, new DockerCli());
  await manager.withSandbox(profile, async (sandbox) => {
    console.log(`Started ${profile} sandbox ${sandbox.id.slice(0, 12)}`);
    console.log(`Workspace: ${sandbox.workspace}`);
    console.log(`State: ${await manager.status(sandbox)}`);
    console.log(`Node: ${await manager.exec(sandbox, ["node", "--version"])}`);
  });
  console.log("Sandbox container and workspace removed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
