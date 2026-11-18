import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SandboxConfig } from "./config.js";
import type { DockerRunner } from "./docker.js";

export interface Sandbox {
  id: string;
  profile: string;
  workspace: string;
}

export interface CreateOptions {
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
        "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
        "--pids-limit", String(profile.pidsLimit),
        "--cpus", String(profile.cpus), "--memory", profile.memory,
        "--user", `${uid}:${gid}`, "--workdir", "/workspace",
        "--mount", mount,
        profile.image, "sleep", "3600"
      ]);
      id = output.trim();
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Docker returned an invalid container ID");
      await this.docker.run(["start", id]);
      return { id, profile: profileName, workspace };
    } catch (error) {
      if (id) {
        try { await this.docker.run(["rm", "-f", id]); } catch { /* retain original error */ }
      }
      await rm(workspace, { recursive: true, force: true });
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

  async destroy(sandbox: Sandbox): Promise<void> {
    const root = await this.ensureRoot();
    const workspace = resolve(sandbox.workspace);
    if (dirname(workspace) !== root || !basename(workspace).startsWith("chh-")) {
      throw new Error("Refusing to remove an unmanaged workspace");
    }
    let dockerError: unknown;
    try {
      await this.docker.run(["rm", "-f", sandbox.id]);
    } catch (error) {
      dockerError = error;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    if (dockerError) throw dockerError;
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
