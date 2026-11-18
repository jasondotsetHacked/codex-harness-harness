import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DockerRunner {
  run(args: readonly string[]): Promise<string>;
}

/** Calls Docker directly, without a shell or string interpolation of commands. */
export class DockerCli implements DockerRunner {
  async run(args: readonly string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync("docker", [...args], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 10 * 60 * 1000
    });
    if (args[0] === "logs") {
      return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
    }
    return stdout.trim();
  }
}
