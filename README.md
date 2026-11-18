# Codex Harness Harness

A local-first development automation system built around the OpenAI Agents API. It will coordinate sandboxed coding agents, independent PR review, correction loops, and guarded GitHub merging.

## First milestone: Session-aware Docker sandbox management

This branch adds a configuration-driven **Sandbox Manager** in TypeScript. It creates disposable workspaces, provisions separate coder and reviewer profiles, limits resources, and cleans up safely. The new SessionSandboxRegistry stores an environment-to-container mapping and prevents duplicate provisioning.

The framework is **not yet connected to an Agents API session**. This first milestone keeps containers offline while we design a real egress-filtered connection and executor key delivery.

### Prerequisites

- Docker Desktop with WSL2 backend and WSL integration enabled.
- Node.js 22 or later in a non-root WSL2 Linux shell.
- Docker CLI access from that shell.

### Get started

\`\`\`bash
npm install
npm test
npm run sandbox:setup
npm run sandbox:doctor
npm run sandbox:smoke -- coder
npm run sandbox:smoke -- reviewer
\`\`\`

The image build happens once and the manager provisions and removes all per-agent containers automatically.

### Commands

\`\`\`bash
npm run chh -- sandbox list
npm run chh -- sandbox logs <environment-id>
npm run chh -- sandbox cleanup <environment-id>
\`\`\`

\`sandboxes.config.json\` contains Docker images, resource limits, and mount permissions. Every profile currently requires \`network: none\`; this is enforced in configuration validation and at Docker creation time.

### Planned next work

1. Add a restricted egress gateway and run \`codex exec-server\` as the container's primary process.
2. Connect self-hosted Agents API sessions and track executor connection events.
3. Add repository checkout, branch creation, and PR publishing.
4. Add an independent review agent, correction loop, and guarded merge.

See [sandbox security](docs/sandbox-security.md) and [Agents API integration notes](docs/agents-api-lifecycle.md).
