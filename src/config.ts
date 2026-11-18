import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export interface SandboxProfile {
  image: string;
  cpus: number;
  memory: string;
  pidsLimit: number;
  network: "none";
  workspaceReadOnly: boolean;
}

export interface SandboxConfig {
  workspaceRoot: string;
  profiles: Record<string, SandboxProfile>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export async function loadSandboxConfig(filename: string): Promise<SandboxConfig> {
  const configFile = resolve(filename);
  const raw = object(JSON.parse(await readFile(configFile, "utf8")) as unknown, "config");
  if (raw.version !== 1) throw new Error("Unsupported sandbox config version");

  if (typeof raw.workspaceRoot !== "string" || !raw.workspaceRoot.startsWith("./")) {
    throw new Error("workspaceRoot must be a relative ./ path");
  }

  const base = dirname(configFile);
  const workspaceRoot = resolve(base, raw.workspaceRoot);
  const rel = relative(base, workspaceRoot);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || rel.startsWith("/") ) {
    throw new Error("workspaceRoot must be a subdirectory of the config directory");
  }

  const profilesRaw = object(raw.profiles, "profiles");
  if (Object.keys(profilesRaw).length === 0) throw new Error("At least one profile is required");
  const profiles: Record<string, SandboxProfile> = {};

  for (const [name, value] of Object.entries(profilesRaw)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error("Invalid profile name");
    const p = object(value, `profile ${name}`);
    if (typeof p.image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(p.image)) {
      throw new Error(`Invalid image for ${name}`);
    }
    if (typeof p.cpus !== "number" || !Number.isFinite(p.cpus) || p.cpus <= 0 || p.cpus > 16) {
      throw new Error(`Invalid cpus for ${name}`);
    }
    if (typeof p.memory !== "string" || !/^[1-9][0-9]*[mg]$/.test(p.memory)) {
      throw new Error(`Invalid memory for ${name}`);
    }
    if (!Number.isInteger(p.pidsLimit) || (p.pidsLimit as number) < 16 || (p.pidsLimit as number) > 1024) {
      throw new Error(`Invalid pidsLimit for ${name}`);
    }
    // Until an egress-filtering gateway exists, reject all networked profiles.
    if (p.network !== "none") throw new Error(`Network access is not yet supported for ${name}`);
    if (typeof p.workspaceReadOnly !== "boolean") {
      throw new Error(`Invalid workspaceReadOnly for ${name}`);
    }
    profiles[name] = {
      image: p.image, cpus: p.cpus, memory: p.memory, pidsLimit: p.pidsLimit as number,
      network: "none", workspaceReadOnly: p.workspaceReadOnly
    };
  }
  return { workspaceRoot, profiles };
}
