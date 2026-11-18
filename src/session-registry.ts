import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SandboxConfig } from "./config.js";
import type { DockerRunner } from "./docker.js";
import { SandboxManager, type Sandbox, type SessionBinding } from "./sandbox-manager.js";

interface RegistryRecord {
  version: 1;
  binding: SessionBinding;
  sandbox: Sandbox;
}

export interface SessionSandboxStatus extends RegistryRecord {
  containerStatus: string;
}

/**
 * Local registry for self-hosted Agents API environments. It binds one OpenAI
 * environment ID to one Docker sandbox. No API keys or remote URLs are stored.
 *
 * Lock directories fail closed after a crash. A future recovery command can
 * remove stale locks after confirming no other orchestrator is using them.
 */
export class SessionSandboxRegistry {
  constructor(
    private readonly config: SandboxConfig,
    private readonly manager: SandboxManager,
    private readonly docker: DockerRunner
  ) {}

  private key(environmentId: string): string {
    if (!environmentId || environmentId.length > 256) {
      throw new Error("A valid environment ID is required");
    }
    return createHash("sha256").update(environmentId).digest("hex");
  }

  private async directory(): Promise<string> {
    await mkdir(this.config.workspaceRoot, { recursive: true });
    const root = resolve(this.config.workspaceRoot);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error("Registry workspace root must be a real directory");
    }
    const state = join(root, ".chh-state");
    await mkdir(state, { recursive: true, mode: 0o700 });
    const stateInfo = await lstat(state);
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || await realpath(state) !== state) {
      throw new Error("Registry state directory must be a real directory");
    }
    return state;
  }

  private async readRecord(environmentId: string): Promise<RegistryRecord | undefined> {
    const file = join(await this.directory(), this.key(environmentId) + ".json");
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const record: unknown = JSON.parse(content);
    if (!isRecord(record) || record.binding.environmentId !== environmentId) {
      throw new Error("Session sandbox registry record is invalid");
    }
    return record;
  }

  private async writeRecord(record: RegistryRecord): Promise<void> {
    const dir = await this.directory();
    const file = join(dir, this.key(record.binding.environmentId) + ".json");
    const temporary = join(dir, ".tmp-" + randomUUID());
    await writeFile(temporary, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async withLock<T>(environmentId: string, fn: () => Promise<T>): Promise<T> {
    const lock = join(await this.directory(), this.key(environmentId) + ".lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Environment is already being provisioned or has a stale lock; inspect it before retrying");
      }
      throw error;
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async get(environmentId: string): Promise<RegistryRecord | undefined> {
    return this.readRecord(environmentId);
  }

  async acquire(profile: string, binding: SessionBinding): Promise<Sandbox> {
    if (!binding.sessionId || binding.sessionId.length > 256) throw new Error("A valid session ID is required");
    return this.withLock(binding.environmentId, async () => {
      const existing = await this.readRecord(binding.environmentId);
      if (existing) {
        if (existing.binding.sessionId !== binding.sessionId || existing.sandbox.profile !== profile) {
          throw new Error("Environment already belongs to a different session or profile");
        }
        try {
          if (await this.manager.status(existing.sandbox) === "running") {
            await stat(existing.sandbox.workspace);
            return existing.sandbox;
          }
        } catch {
          // Do not replace compute automatically: its workspace and running state may be recoverable.
        }
        throw new Error("Registered environment is not healthy; inspect and clean up before replacing it");
      }

      // A crash between Docker startup and writing the registry record can leave a
      // container with no record. Detect it by immutable labels instead of duplicating it.
      const label = "label=chh.environment_sha256=" + this.key(binding.environmentId);
      const orphans = await this.docker.run(["ps", "-aq", "--filter", label]);
      if (orphans.trim()) {
        throw new Error("Unregistered container exists for this environment; inspect Docker before retrying");
      }

      const sandbox = await this.manager.create(profile, { session: binding });
      try {
        await this.writeRecord({ version: 1, binding, sandbox });
      } catch (error) {
        await this.manager.destroy(sandbox);
        throw error;
      }
      return sandbox;
    });
  }

  async release(environmentId: string): Promise<boolean> {
    return this.withLock(environmentId, async () => {
      const record = await this.readRecord(environmentId);
      if (!record) return false;
      await this.manager.destroy(record.sandbox);
      await rm(join(await this.directory(), this.key(environmentId) + ".json"));
      return true;
    });
  }

  async list(): Promise<SessionSandboxStatus[]> {
    const directory = await this.directory();
    const records: SessionSandboxStatus[] = [];
    for (const filename of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const parsed: unknown = JSON.parse(await readFile(join(directory, filename), "utf8"));
      if (!isRecord(parsed) || this.key(parsed.binding.environmentId) + ".json" !== filename) {
        throw new Error("Invalid registry record: " + filename);
      }
      let containerStatus = "unknown";
      try { containerStatus = await this.manager.status(parsed.sandbox); } catch { containerStatus = "unavailable"; }
      records.push({ ...parsed, containerStatus });
    }
    return records;
  }
}

function isRecord(value: unknown): value is RegistryRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<RegistryRecord>;
  return r.version === 1 &&
    !!r.binding && typeof r.binding.sessionId === "string" &&
    typeof r.binding.environmentId === "string" &&
    !!r.sandbox && typeof r.sandbox.id === "string" &&
    typeof r.sandbox.workspace === "string" && typeof r.sandbox.profile === "string";
}
