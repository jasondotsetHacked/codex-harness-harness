# Codex Harness Harness

A local-first development automation system built around the OpenAI Agents API.

The intended workflow is: developer task → sandboxed coding agent → GitHub pull request → independent review → correction loop → guarded merge. Project-specialist conversations and task planning will be added on top of that workflow.

## First milestone: Local Sandbox Manager

This branch adds a **configuration-driven Docker sandbox manager** in TypeScript. It provisions disposable per-run workspaces with separate `coder` and `reviewer` profiles, runs commands, inspects container status, and cleans up after execution. It does **not** yet connect to the Agents API or create pull requests.

### Prerequisites

- Docker Desktop with its WSL2 backend enabled and WSL integration configured.
- Node.js 22 or later inside a **non-root** WSL2 Linux shell.
- Docker CLI available from that shell.

### Run it

```bash
npm install
npm test
npm run sandbox:smoke -- coder
npm run sandbox:smoke -- reviewer
```

The smoke command creates a container, checks its status, runs `node --version` inside it, and removes both the container and its temporary workspace. Docker may need to pull the configured image on the first run.

### Configuration

Edit [`sandboxes.config.json`](sandboxes.config.json) to set an image, CPU/memory/PID limits, or the workspace mount mode for each agent role. All profiles currently require `"network": "none"`. This restriction is intentional until a controlled outbound network path for the Agents API executor is implemented.

### Next steps

1. Connect a self-hosted Agents API session and its Codex executor to a sandbox through a controlled network gateway.
2. Add repository checkout, branch creation, and PR publishing.
3. Add an independent PR reviewer and an iterative correction loop.
4. Apply CI and policy gates before automatic merging.

Security constraints and known limitations are documented in [`docs/sandbox-security.md`](docs/sandbox-security.md).

## Documentation

- [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview)
- [Self-hosted sandbox guide](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
