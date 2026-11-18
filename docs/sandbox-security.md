# Sandbox security (initial implementation)

## Boundary

The local orchestrator runs in WSL2 and holds the Docker privileges. Sandboxed commands run as the local non-root Linux UID/GID in disposable containers. Agent containers are **not** given the Docker socket, host home directory, SSH keys, GitHub tokens, or main OpenAI API key.

Every container is created with `--network none`, a read-only root filesystem, dropped capabilities, `no-new-privileges`, and CPU/memory/PID limits. The coder workspace is writable; the reviewer workspace is mounted read-only. Both have a limited writable `/tmp`.

The manager uses an automatically created per-run directory under `.sandbox-workspaces/` and removes it and the container after use. It never runs user-supplied commands through a host shell.

## Known limitations

- Docker containers are a useful isolation layer, not a complete defense against kernel or runtime vulnerabilities.
- Container creation requires host-level Docker access. **Never** expose the manager as a public service without strong authentication and policy checks.
- Local workspace contents are read and modified by agents. Keep credentials and private files out of the workspace.
- The example `node:22-alpine` image uses a mutable tag. Pin a trusted image digest before use with untrusted repositories.
- The manager is deliberately **offline** today. Networked Agents API executors require controlled outbound access to `api.openai.com` and `codex-cloud-environments.chatgpt.com`, enforced by an external egress policy. Do not replace `none` with a plain Docker bridge and assume it is restricted.
- The implementation does not yet connect to the Agents API, run Codex, clone repositories, manage PRs, or merge them. Those are subsequent milestones.

## Next security milestone

Add an egress-controlled executor profile with specific allowed remote endpoints, restricted environment credentials, and a verified network policy before starting self-hosted Agents API sessions.
