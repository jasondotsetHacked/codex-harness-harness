import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DockerCli } from "../src/docker.js";

test("Docker logs includes stderr while other commands return only stdout", {
  skip: process.platform === "win32"
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chh-docker-test-"));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "docker"), [
    "#!/bin/sh",
    "if [ \"$2\" != stderr-only ]; then printf 'stdout line\\n'; fi",
    "printf 'stderr line\\n' >&2",
    ""
  ].join("\n"), { mode: 0o700 });
  process.env.PATH = [directory, previousPath].filter(Boolean).join(delimiter);

  const docker = new DockerCli();
  assert.equal(await docker.run(["logs", "both"]), "stdout line\nstderr line");
  assert.equal(await docker.run(["logs", "stderr-only"]), "stderr line");
  assert.equal(await docker.run(["inspect", "both"]), "stdout line");
});
