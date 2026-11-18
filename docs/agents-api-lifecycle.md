# Agents API lifecycle integration

The OpenAI Agents API runs the agent harness; our Docker containers provide local compute for the **self-hosted executor**.

## Mapping

A self-hosted session returns a session ID, an environment ID, and a remote URL. One environment ID requires one executor. Use the session's remote URL unchanged; don't construct a URL from the ID.

The SessionSandboxRegistry stores session ID, environment ID, container ID, profile, and workspace in a private local state directory. The environment ID is hashed for the registry filename and Docker labels. It does **not** store either API key or the remote URL.

- An acquire for a running environment returns its existing sandbox.
- A second session cannot claim the same environment.
- An unexpected Docker stop does not silently create replacement compute; inspect the workspace first.
- An orphaned labeled container is detected before a new container is provisioned.
- A stale lock after a crash fails closed and needs manual investigation.
- Reuse an environment across agent turns while preserving its working files.
- Keep a fresh reviewer session and independent snapshot for each PR revision.

## Executor connection (next milestone)

The current smoke-test container runs an idle process without a fixed one-hour timeout. **It is not connected to the Agents API.**

After enforcing outbound egress policy and obtaining a restricted environment key, the next integration should run the following as the **primary container process**:

```bash
codex exec-server --remote "$REMOTE_URL" --environment-id "$ENVIRONMENT_ID"
```

The executor reads its restricted environment key as CODEX_API_KEY. The main OPENAI_API_KEY stays with the orchestrator. No API keys belong in Docker command-line arguments, images, checked-in files, or logs. A production launcher should deliver the environment key through a controlled secret channel and keep it out of Docker inspect and process metadata where feasible.

The orchestrator must also track three separate states:

1. Container state from Docker.
2. Executor connection state from Agents API events (pending / connected / failed / disconnected).
3. Turn state (submitted / executing / complete / failed).

A running Docker container is not evidence that the executor connected. OpenAI's event stream is the source for API readiness.

An interrupted turn must be reconciled with server state before resubmission. When shutting down, prevent new input and coordinate Docker cleanup with session state. Deleting the API session and stopping Docker compute are separate operations.

## Developer experience

- `npm run sandbox:setup` builds the development image once; sandboxes themselves are created on demand.
- `npm run sandbox:doctor` checks Docker and configured image availability.
- `npm run sandbox:smoke -- coder` runs the offline lifecycle test.
- `npm run chh -- sandbox list` lists persisted environment records.
- `npm run chh -- sandbox logs <environment-id>` reads the corresponding Docker logs.
- `npm run chh -- sandbox cleanup <environment-id>` removes a registered environment.
- `chh run`, streaming events, cancellation, reconnection, automatic cleanup of orphans, and cost limits remain follow-on milestones.

## References

- https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted
- https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle
- https://developers.openai.com/api/docs/guides/agents-api/environments/security
