import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { SandboxConfig } from "./config.js";
import type { DockerRunner } from "./docker.js";

export interface Sandbox {
  id: string;
  profile: string;
  workspace: string;
}

export interface SessionBinding {
  sessionId: string;
  environmentId: string;
}

export interface CreateOptions {
  session?: SessionBinding;
  /** Runs on the host before the container starts; use to place project files in the new workspace. */
  prepareWorkspace?: (directory: string) => Promise<void>;
}

export class SandboxManager {
  constructor(private readonly config: SandboxConfig, private readonly docker: DockerRunner) {}

  private async ensureRoot(): Promise<string> {
    await mkdir(this.config.workspaceRoot, { recursive: true });
    const info = await lstat(this.config.workspaceRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Sandbox root cannot be a symlink");
    }
    const real = await realpath(this.config.workspaceRoot);
    if (real !== resolve(this.config.workspaceRoot)) {
      throw new Error("Sandbox root resolved to an unexpected location");
    }
    return real;
  }

  async create(profileName: string, options: CreateOptions = {}): Promise<Sandbox> {
    const profile = this.config.profiles[profileName];
    if (!profile) throw new Error(`Unknown sandbox profile: ${profileName}`);
    if (profile.network !== "none") throw new Error("Network access is not supported yet");
    if (options.session && (!options.session.sessionId || !options.session.environmentId || options.session.sessionId.length > 256 || options.session.environmentId.length > 256)) {
      throw new Error("Invalid session/environment binding");
    }

    // Bind mounts remain writable for the local WSL user, but the agent never runs as root.
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0) {
      throw new Error("Run the orchestrator as a non-root WSL2 Linux user");
    }

    const root = await this.ensureRoot();
    const workspace = await mkdtemp(join(root, "chh-"));
    const name = `chh-${randomUUID()}`;
    let id: string | undefined;

    try {
      await options.prepareWorkspace?.(workspace);
      const mount = `type=bind,source=${workspace},target=/workspace${profile.workspaceReadOnly ? ",readonly" : ""}`;
      const output = await this.docker.run([
        "create", "--name", name,
        "--label", "chh.managed=true", "--label", `chh.profile=${profileName}`,
        ...(options.session ? [
          "--label", "chh.session_sha256=" + createHash("sha256").update(options.session.sessionId).digest("hex"),
          "--label", "chh.environment_sha256=" + createHash("sha256").update(options.session.environmentId).digest("hex")
        ] : []),
        "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
        "--tmpfs", `/home/agent:rw,nosuid,nodev,size=256m,uid=${uid},gid=${gid},mode=0700`,
        "--env", "HOME=/home/agent",
        "--pids-limit", String(profile.pidsLimit),
        "--cpus", String(profile.cpus), "--memory", profile.memory,
        "--user", `${uid}:${gid}`, "--workdir", "/workspace",
        "--mount", mount,
        // The idle command is a smoke-test placeholder. A real agent will run codex exec-server
        // as the container primary process after approved egress is implemented.
        profile.image, "sleep", "infinity"
      ]);
      id = output.trim();
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Docker returned an invalid container ID");
      await this.docker.run(["start", id]);
      return { id, profile: profileName, workspace };
    } catch (error) {
      // Use the unique name if Docker created a container but failed before returning its ID.
      // Never delete the mounted workspace if Docker cannot confirm removal.
      try {
        await this.docker.run(["rm", "-f", id ?? name]);
        await rm(workspace, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Sandbox creation failed and cleanup was incomplete; manual inspection required");
      }
      throw error;
    }
  }

  async exec(sandbox: Sandbox, args: readonly string[]): Promise<string> {
    if (args.length === 0) throw new Error("An executable command is required");
    return this.docker.run(["exec", "--workdir", "/workspace", sandbox.id, ...args]);
  }

  async status(sandbox: Sandbox): Promise<string> {
    return this.docker.run(["inspect", "--format", "{{.State.Status}}", sandbox.id]);
  }

  async logs(sandbox: Sandbox): Promise<string> {
    return this.docker.run(["logs", "--tail", "200", "--timestamps", sandbox.id]);
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    const root = await this.ensureRoot();
    const workspace = resolve(sandbox.workspace);
    if (dirname(workspace) !== root || !basename(workspace).startsWith("chh-")) {
      throw new Error("Refusing to remove an unmanaged workspace");
    }
    if (!/^[a-f0-9]{12,64}$/.test(sandbox.id)) throw new Error("Refusing to remove an invalid container ID");
    // A failed Docker deletion may leave a running container with this workspace mounted.
    // Preserve its files so the operator can inspect or retry cleanup safely.
    try {
      await this.docker.run(["rm", "-f", sandbox.id]);
    } catch (error) {
      if (!(error instanceof Error) || !/No such container/i.test(error.message)) throw error;
    }
    await rm(workspace, { recursive: true, force: true });
  }

  async withSandbox<T>(
    profile: string,
    work: (sandbox: Sandbox) => Promise<T>,
    options: CreateOptions = {}
  ): Promise<T> {
    const sandbox = await this.create(profile, options);
    try {
      return await work(sandbox);
    } finally {
      await this.destroy(sandbox);
    }
  }
}
