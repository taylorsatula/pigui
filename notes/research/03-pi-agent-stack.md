# Pi agent stack reference (for a remote "Pi harness")

Source: `/home/user/refs/pi` (earendil-works/pi, commit 780bf31, all packages at 1.6.0). All paths below are relative to that repo root unless absolute. Line numbers are from this checkout. Scope: packages/ai, agent, coding-agent, codemode, mcp, env, tui (skim), schema, telemetry, plus README.md / AGENTS.md. Durable internals, apps/p2, apps/p3 and chord are covered elsewhere; they are mentioned only where they bear on the agent stack.

Headline finding: **pi-durable does not sit on top of pi-agent-core or pi-coding-agent.** It depends on pi-ai (model access), pi-schema, pi-telemetry, pi-codemode and chord, and re-implements the agent loop, session/transcript store, the read/write/edit/bash tools and the hook system itself. A server harness built on Pi Durable therefore uses `pi-ai` + `pi-durable` (+ `pi-env`, `pi-mcp`, `pi-codemode`), and treats `pi-agent-core` / `pi-coding-agent` as reference implementations, not as dependencies.

---

## 1. Package map

### Dependency graph (from each `package.json`)

```
pi-telemetry  (no deps)                     pi-schema (no deps)
      ^   ^                                       ^
      |   +-------------------+-------------------+
      |                       |                   |
   pi-ai  ---------------> (schema, telemetry)    |
      ^                                           |
      +--- pi-agent-core  (ai, schema)            |
      |        ^                                  |
      |        +--- pi-coding-agent (agent-core, ai, codemode, mcp, tui, typebox, ...)
      |
      +--- pi-durable (chord, ai, codemode, schema, telemetry, photon, diff)
               ^
               +--- pi-env (chord, durable)

pi-codemode (quickjs-wasi only)   pi-mcp (cross-spawn only)   pi-tui (marked etc.)
chord (schema, telemetry; peers esbuild/react/ws)
```

Evidence: `packages/ai/package.json` deps (`@earendil-works/pi-schema`, `pi-telemetry`, provider SDKs); `packages/agent/package.json` deps (`pi-ai`, `pi-schema`); `packages/coding-agent/package.json` deps (`pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-tui`, typebox, jiti, quickjs-wasi, ...); `packages/durable/package.json` deps (`chord`, `pi-ai`, `pi-codemode`, `pi-schema`, `pi-telemetry`, `@silvia-odwyer/photon`, `diff`); `packages/env/package.json` deps (`chord`, `pi-durable`); `packages/mcp/package.json` deps (`cross-spawn` only).

What `packages/durable` imports (counted over `packages/durable/src`): chord (`context`, `delta`, `json`, `output`, `sqlite`, `watch`), `pi-ai` (+ `session-resources`, `utils/estimate|identity|overflow|retry|streaming-json|transcript|uuid|validation`), `pi-codemode` (+ `declarations`, `portable`, `source`), `pi-schema`, `pi-telemetry`. **No import of `pi-agent-core`, `pi-coding-agent`, `pi-mcp`, `pi-env` or `pi-tui`.** The only textual mention of agent-core is a comment (`packages/durable/src/harness/generation.ts:839`, "as pi-agent-core's agent loop does"). `pi-mcp` is consumed by apps/p2 (`apps/p2/package.json:31`), not by durable. `pi-env` depends on durable (it implements durable's `ExecutionEnv`).

Root build order (`package.json` scripts.build): telemetry, schema, chord, tui, codemode, mcp, ai, durable, env, agent, coding-agent. Workspaces include the gondolin example (`package.json` workspaces).

### Per-package summary

**@earendil-works/pi-ai** (`packages/ai`) — unified multi-provider LLM client. Core entry `src/index.ts` is "side-effect free": types, `Models`/`createModels`/`createProvider` (`src/models.ts`), auth types, `faux` test provider, event-stream/streaming-json/retry/overflow/transcript utilities, `calculateCost`. Provider factories live under `./providers/*` (e.g. `providers/anthropic`, `providers/all` -> `builtinModels()`), API implementations under `./api/*`, a legacy global API under `./compat` (exports map in `package.json`). Also a CLI `pi-ai` (`bin`) for `login`/`list`. Also does image generation and "classifier" models (README `## Image Generation`, `## Classification`). Depends on pi-schema, pi-telemetry and the Anthropic/OpenAI/Google/Bedrock SDKs.

**@earendil-works/pi-agent-core** (`packages/agent`) — small stateful agent loop on top of pi-ai: `Agent` class (`src/agent.ts`), low-level `agentLoop`/`agentLoopContinue`/`runAgentLoop`/`runToolCall` (`src/agent-loop.ts`), `streamProxy` for browser->server proxying (`src/proxy.ts`), types (`src/types.ts`). 2.5k lines total. Used only by pi-coding-agent in this repo.

**@earendil-works/pi-coding-agent** (`packages/coding-agent`) — the `pi` CLI (`bin.pi = dist/bundle/cli.js`) plus an SDK. Contains the built-in tools (`src/core/tools/`), system prompt (`src/core/system-prompt.ts`), JSONL tree session store (`src/core/session-manager.ts`, 2038 lines), compaction (`src/core/compaction/`), extension system (`src/core/extensions/`, ~5k lines), skills, prompt templates, project trust, settings, auth storage (`auth.json`), package manager for extension bundles, built-in extensions for codemode / MCP / llama.cpp (`src/extensions/`), and four run modes (interactive TUI, print, JSON, RPC; `src/modes/`). Exports `createAgentSession`, `AgentSession`, `SessionManager`, `RpcClient`, `runRpcMode`, `runPrintMode`, tool factories (`src/index.ts:253-438`). Exports map: `.` and `./rpc-entry`.

**@earendil-works/pi-codemode** (`packages/codemode`) — runs model-written JavaScript in a QuickJS-WASM VM whose only capability is calling injected tools; "no pi dependencies" (`README.md:1-5`). Sandboxes: `CodemodeSandbox` (Node/Bun worker thread), `InlineCodemodeSandbox` (calling thread), `RemoteCodemodeSandbox` (Cloudflare DO, `./portable`, `./cloudflare`). Also TypeScript declaration rendering for tools (`src/declarations.ts`). Imported by durable (`durable/src/codemode/`) and coding-agent (`src/extensions/codemode/`).

**@earendil-works/pi-mcp** (`packages/mcp`) — standalone MCP client (does not use the official SDK, `README.md:3`). `McpClient` (`src/client.ts`), transports: stdio, streamable HTTP, `PipeTransport` (stdio framing over a program started elsewhere, e.g. via pi-env `openProcess`), in-memory (`src/transports/`), MCP OAuth (`./oauth`), `toLlmContent()` result conversion, `createMcpToolName()` => `mcp__<server>__<tool>` (README). Legacy SSE transport not supported (`coding-agent/docs/mcp.md`).

**@earendil-works/pi-env** (`packages/env`) — remote execution for Pi Durable: a Rust daemon (`daemon/`) that runs on the target machine and speaks a framed stdin/stdout protocol (`docs/protocol.md`), plus `RemoteExecutionEnv` (`src/remote-env.ts`, 979 lines) implementing durable's `ExecutionEnv`, SSH deployment/connection (`src/ssh.ts`), `LocalExecutionEnv`, pty terminals (`src/terminal.ts`), plain-pipe processes (`src/process.ts`, for MCP servers), file watching (`src/watch.ts`). Exports listed at `src/index.ts:1-33`.

**@earendil-works/pi-tui** (`packages/tui`) — terminal UI framework (differential rendering, Editor, Markdown, Image, etc.); used only by the CLI and p2/chord TUI. Irrelevant to a server harness except that extension tools may import it for rendering. Skimmed only.

**@earendil-works/pi-schema** (`packages/schema`) — eval-free JSON Schema (2020-12/7) builders and validator (`obj`, `str`, `opt`, `int`, `oneOf`, `compile`, `Static`), "no dependencies", usable under strict CSP (`README.md:1-12`). pi-ai, agent-core, durable all use it for tool parameter schemas. coding-agent still uses TypeBox (`typebox` dep) for its own tool schemas; pi-schema's `Static` also understands TypeBox kinds (`agent/src/types.ts:465-469`).

**@earendil-works/pi-telemetry** (`packages/telemetry`) — vendor-neutral `TelemetryContext`/`TelemetrySpan` contract, no-op context, in-memory reference adapter, metrics, typed schemas, conformance tests (`README.md:1-16`). No exporter and no global span state; contexts are passed explicitly (e.g. `ProviderRequestOptions.telemetry`, `ai/src/types.ts:166`). An OTel/Sentry adapter would be ours to write.

---

## 2. packages/ai

### 2.1 Provider abstraction

- A **`Models`** collection (`ai/src/models.ts:266-376`) holds **`Provider`** objects (`models.ts:158-264`). `createModels({credentials, modelsStore, authContext, identity})` (`models.ts:384-389, 1059`); `builtinModels()` registers every provider (`ai/src/providers/all.ts:187-192`). `MutableModels.setProvider/deleteProvider` (`models.ts:377-382`).
- `Provider` = `{id, name, baseUrl, headers, auth: {apiKey?, oauth?}, getModels(), refreshModels?(), filterModels?(), stream(), streamSimple(), fetchDeferred?, generateImages?, classify?}` (`models.ts:158-264`). `Models.stream/complete/streamSimple/completeSimple` resolve auth through the owning provider, merge headers (`provider auth -> model.headers -> options.headers -> transformHeaders`), then dispatch (README `## Auth`, lines 376-432).
- Wire **API implementations** are separate from providers (`ai/src/types.ts:66-77`): `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, `pi-messages`. A provider with models of several APIs passes a map keyed by `model.api` (README 1349-1362). `pi-messages` is Pi's own wire protocol (POST `{model, context, options}` to `<baseUrl>/messages`, SSE reply), spoken by the Radius gateway and usable by any backend (`ai/src/api/pi-messages.ts:1-10`) — a ready-made protocol for a thin server-side model proxy.
- **Custom provider** = `createProvider({id, auth, models, api})` (`models.ts:1063-1108`, README `### createProvider()` 1270-1410), with `envApiKeyAuth(name, [ENV])` helper, dynamic catalogs via `fetchModels`/`refresh()` + `ModelsStore`, `compat` flags for OpenAI-compatible servers, `thinkingLevelMap` per model.
- Request options (`ai/src/types.ts:163-295, 387-397`): `signal`, `apiKey`, `fetch` (injectable), `env` (provider-scoped env overriding `process.env`), `headers`, `onPayload` (inspect/replace provider body), `onResponse`, `onProviderStreamEvent`, `identity` (User-Agent/attribution), `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `temperature`, `maxTokens`, `cacheRetention`, `sessionId`, `telemetry`, `metadata`; simple options add `reasoning` (`off|minimal|low|medium|high|xhigh|max`), `thinkingBudgets`, `toolChoice`, `deferred` (async/"deferred" responses with a durable handle: `StopReason` includes `"deferred"`, `types.ts:499`).
- `Context` = `{systemPrompt?, messages, tools?}` (`types.ts:798-802`); normalized into a transcript where the system prompt and tool declarations are carried by leading/mid-conversation **`SystemMessage`s with `sections`, `toolsAdded`, `toolsRemoved`** (`types.ts:565-587`). This lets prompt/tool changes be appended without breaking prompt cache; durable and coding-agent both store this form.

### 2.2 Providers and models

43 built-in providers in `builtinProviders()` (`providers/all.ts:134-185`): amazon-bedrock, ant-ling, **anthropic**, azure, baseten, cerebras, cloudflare-ai-gateway, cloudflare-workers-ai, deepseek, fireworks, github-copilot, google, google-vertex, groq, huggingface, kimi-coding, meta, minimax(+cn), mistral, moonshotai(+cn), nvidia, openai, openai-codex, opencode, opencode-go, openrouter, qwen-token-plan (4 variants), radius, together, typesafe, vercel-ai-gateway, xai, xiaomi (4 variants), zai, zai-coding-cn. Plus any OpenAI-compatible endpoint (README 62-98).

Model catalog: generated into `ai/src/models.generated.ts` (do not edit; `AGENTS.md` Code Quality) from `ai/catalog/providers/*.ts` + models.dev data; `Model` carries `contextWindow`, `maxTokens`, `cost` (per-Mtok, with `tiers`), `input` modalities, `reasoning`, `thinkingLevelMap`, `promptCache`, `inputLimits` (`types.ts:866-902`). Anthropic catalog (`ai/catalog/providers/anthropic.ts`) includes Claude Fable 5.2 (hard-coded, `:19-31`), the 5.5 family (`claude55ThinkingLevels`, `:16`), Opus 5/4.8 fallbacks, 1M-context for Opus/Sonnet 4.6 (`:14`). Provider factory: `ai/src/providers/anthropic.ts:74-90`.

### 2.3 Auth, API keys, subscriptions (Anthropic in detail)

- Every provider owns its auth: `ProviderAuth = {apiKey?: ApiKeyAuth, oauth?: OAuthAuth}` (`auth/types.ts`). `Models.getAuth()` returns `{auth: {apiKey, headers, baseUrl}, source}` or undefined if unconfigured; request paths surface failures as stream errors (README 376-408).
- **Credential store** is an injected interface (`auth/credential-store.ts`): `read/list/modify/delete`, `modify` is serialized read-modify-write so OAuth refresh cannot double-refresh across processes (README 461-486). Default in-memory; coding-agent supplies an `auth.json`-backed one with file locking (`coding-agent/src/core/auth-storage.ts:2,64`). **A server harness must provide its own `CredentialStore`** (e.g. DB-backed, per-user). A stored credential owns its provider: env vars are consulted only when nothing is stored, and a failed refresh never silently falls back to an env key (README 486).
- **Anthropic resolution order** (`ai/src/providers/anthropic.ts:28-70`): stored credential -> `ANTHROPIC_AUTH_TOKEN` (Bearer header) -> `ANTHROPIC_OAUTH_TOKEN` -> `ANTHROPIC_API_KEY` -> workload identity federation (`ANTHROPIC_FEDERATION_RULE_ID` + `ANTHROPIC_ORGANIZATION_ID` + `ANTHROPIC_IDENTITY_TOKEN_FILE`, optional `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`; the Anthropic SDK exchanges and refreshes). Env var names are in `ai/src/env-api-keys.ts`; per-request override `options.apiKey` always wins. Provider-scoped env can also be injected via `options.env` rather than `process.env` (`types.ts:171-176`; README `### Provider-Scoped Environment Overrides` 1783).
- **Anthropic subscription OAuth (Claude Pro/Max)**: `provider.auth.oauth = lazyOAuth({name: "Anthropic (Claude Pro/Max)", isSubscription: true, load: loadAnthropicOAuth})` (`providers/anthropic.ts:81-85`). Flow in `ai/src/auth/oauth/anthropic.ts`: PKCE against `https://claude.ai/oauth/authorize`, token URL `https://platform.claude.com/v1/oauth/token`, local callback server on port 53692 (`:15-19`), or copy-code redirect, scopes include `user:inference user:sessions:claude_code user:mcp_servers user:file_upload` (`:25-26`); refresh handled in `refreshAnthropicToken` (`:119+`) with 5-minute early expiry (`:~17`). The login is driven by `Models.login(provider, 'oauth', interaction)` where `interaction.prompt/notify` is provider-neutral (`auth_url`, `device_code`, `manual_code` events; README 1814-1846), so a web UI can host it.
- **Important caveat for a cloud product**: when the key is an OAuth token, `anthropic-messages` switches to "stealth" Claude Code impersonation: adds beta flags `claude-code-20250219`, `oauth-2025-04-20` (`api/anthropic-messages.ts:1392`), prepends the system block "You are Claude Code, Anthropic's official CLI for Claude." (`:1488-1493`), and renames tools to Claude Code's canonical casing (`Read`, ... `toClaudeCodeName`, `:108-111, 1009, 1658, 1746, 1931`), with a pinned `claudeCodeVersion = "2.1.322"` (`:109`) and Claude Code identity headers (`:1291-1311`). Using subscription tokens from a hosted multi-user service is a policy/ToS question for us, not a technical blocker; API keys / WIF avoid it.
- Other subscription-style OAuth: OpenAI (Sign in with ChatGPT), OpenAI Codex, GitHub Copilot, OpenRouter (mints API key), Kimi, xAI, Radius (`auth/oauth/*.ts`, README 1802-1812). Docker Sandboxes doc shows token-substitution via proxy: provider key stays on host, sandbox gets a placeholder (`coding-agent/docs/containerization.md`, "Use a Claude Pro or Max token").
- Key from a command: `"key": "!security find-generic-password ..."` in `auth.json` (`coding-agent/docs/providers.md`).

### 2.4 Streaming event format

`models.stream()` returns an `AssistantMessageEventStream` (async-iterable + `.result()`), event union `AssistantMessageEvent` (`ai/src/types.ts:833-850`):

```
start{partial}
text_start|text_delta|text_end{contentIndex, delta|content, partial}
thinking_start|thinking_delta|thinking_end{...}
toolcall_start|toolcall_delta|toolcall_end{contentIndex, toolCall, partial}
done{reason: stop|length|toolUse|deferred, message}
error{reason: aborted|error, error: AssistantMessage}
```

Contract (`types.ts:818-832`): always `start` first, terminal `done` or `error`; failures after request setup are encoded in the stream (final message `stopReason: "error"|"aborted"` + `errorMessage`), though direct `streamSimple()` may throw synchronously if auth is missing. `partial` is a shared live object, not a snapshot. Tool-call arguments are parsed incrementally (`utils/streaming-json.ts`, `ToolCallArgumentsStream`). `AgentLoop`/`Agent` forward these as `message_update.assistantMessageEvent`. For network transport to a browser, `agent/src/proxy.ts:19-48` defines a bandwidth-reduced `ProxyAssistantMessageEvent` (no `partial`).

### 2.5 Message and tool-call format

- `Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage` (`types.ts:669`).
- `AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]` plus `api, provider, model, responseModel?, responseId?, usage, stopReason, errorMessage?, thinkingLevel?, diagnostics?, durationMs` (`types.ts:595-627`). `ThinkingContent` keeps opaque `thinkingSignature` and `redacted` for replay (`:438-446`). Cross-provider handoff re-serializes via `api/transform-messages.ts` (README `## Cross-Provider Handoffs` 1579).
- `ToolCall = {type:"toolCall", id, name, arguments: JsonObject, thoughtSignature?, namespace?, argumentsError?}` (`types.ts:454-467`). Malformed JSON arguments yield `arguments: {}` + `argumentsError`, which makes validation fail with the model's text.
- `ToolResultMessage = {role:"toolResult", toolCallId, toolName, content: (Text|Image)[], details?, usage?, nestedCalls?, isError, durationMs}` (`types.ts:650-667`). `nestedCalls` records calls a tool (e.g. codemode) made to other tools (`:629-648`).
- `Tool = {name, description, parameters: JSON Schema, constrainedSampling?}` (`types.ts:781-786`); schema may come from pi-schema, TypeBox or plain JSON Schema. `validateToolArguments` in `utils/validation.ts`.

### 2.6 Token / cost accounting

- `Usage = {input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost: {input, output, cacheRead, cacheWrite, total, totalFromProvider?}}` on every `AssistantMessage` (`types.ts:469-497`).
- `calculateCost(model, usage)` (`models.ts:1289-1308`): per-Mtok rates, tiered by prompt size (`model.cost.tiers`), 1h Anthropic cache writes billed at 2x input. `totalFromProvider` is true when the provider reports billed cost (OpenRouter) (README 235-241).
- Prompt caching: `cacheRetention` ("short"/"long"/"none"), Anthropic `cache_control: ephemeral` with optional `ttl:"1h"` (`api/anthropic-messages.ts:96-104`); **Anthropic message threads** (server-side continuation via `sessionId`, `message-threads-2026-08-12` beta; call `cleanupSessionResources(sessionId)` at end; README 1405); `cache-warming.ts` policy (when to refresh a cache entry vs. let it lapse, cost-based) used by coding-agent's `cache-warmer.ts`.
- Aggregation: coding-agent records per-session totals from messages plus `usage` entries (`session-format.md` UsageEntry; `src/core/usage-totals.ts`); durable keeps `docs["pi.usage"]` per `provider/model` and per tool (`durable/README.md` "Usage and Cost").
- Telemetry: `AI_TELEMETRY_SCHEMA` (`models.ts:73`), spans via `options.telemetry` (README `## Telemetry` 1116).

---

## 3. packages/agent (pi-agent-core)

### 3.1 Types (`agent/src/types.ts`)

- `AgentMessage = Message | CustomAgentMessages[...]` — apps add roles by declaration merging (`:365-374`); `convertToLlm` maps/filters them before each request (`:222`), `transformContext` prunes/injects first (`:244`).
- `AgentTool<TParameters, TDetails> extends Tool` (`:478-511`): `label`, `prepareArguments?`, `outputSchema?`, `execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>`, `replay?: "never"|"safe"` (recovery policy; for durable-style crash recovery), `executionMode?: "sequential"|"parallel"`.
- `AgentToolResult = {content, details, structuredContent?, usage?, isError?, terminate?}` (`:424-446`). Throw or return `isError:true` for failures (`:492`).
- `AgentLoopConfig extends SimpleStreamOptions` (`:193-342`) with hooks: `convertToLlm`, `transformContext`, `getApiKey(provider)` (called per LLM call; for expiring OAuth tokens), `prepareRequest` (before every provider request; may swap context/model/thinking), `prepareNextTurn`, `finishTurn` (-> `{action:"continue"|"end"}`), `getSteeringMessages`, `getFollowUpMessages`, `toolExecution` ("parallel" default, `:315`), `beforeToolCall` (can `{block, reason, terminate}`), `afterToolCall` (patch `content/details/isError/usage/terminate/structuredContent`).
- `AgentEvent` (`:528-551`): `agent_start`, `agent_end{messages}`, `turn_start`, `turn_end{message, toolResults}`, `message_start|update|end`, `tool_execution_start|update|end{toolCallId, toolName, args|partialResult|result, isError, durationMs}`. A "turn" = one assistant response + its tool calls.
- `AgentState` (`:382-421`): `systemPrompt` (read-only; replayed from system messages), `model`, `thinkingLevel`, `tools`, `messages`, `isStreaming`, `streamingMessage`, `pendingToolCalls`, `errorMessage`.

### 3.2 Loop (`agent/src/agent-loop.ts`)

- `runLoop` (`:172`): outer loop for follow-ups, inner loop for tool calls + steering. Per turn: `prepareNextTurn` -> declare tool changes as a system message (`declareToolChanges`, `:342`) -> `prepareRequest` -> `streamAssistantResponse` (`:390`) -> `executeToolCalls` (`:518`, sequential `:540` or parallel `:592`) -> `finishTurn` -> `turn_end`.
- Tool call pipeline `prepareToolCall` (`:708-779`): abort check -> find tool (else `Tool X not found` error result) -> `prepareArguments` -> schema validation -> `beforeToolCall` (block => error tool result with `reason`) -> execute (`executePreparedToolCall` `:824`) -> `afterToolCall` (`finalizeExecutedToolCall` `:862`) -> `tool_execution_end` -> tool-result message (`:933-949`). In parallel mode tools are preflighted sequentially, run concurrently, `tool_execution_end` fires in completion order, result messages in source order (`types.ts:39-47`).
- Truncated assistant message with partial tool calls: `failToolCallsFromTruncatedMessage` (`:488`) records error results so no call is left without a result. Abort mid-batch: every call still gets a result "Operation aborted" (`:716-722`, issue #9986).
- `runToolCall(toolCall, {tools, ...hooks})` (`:814`) runs one call through the same validation/hook pipeline; used by codemode so nested calls obey `beforeToolCall`/`afterToolCall` (`agent/README.md` "MCP and Codemode").

### 3.3 `Agent` class (`agent/src/agent.ts`) — how a consumer drives it

```ts
const agent = new Agent({ initialState:{systemPrompt, model, tools}, streamFn: models.streamSimple.bind(models), convertToLlm?, beforeToolCall?, ... });
agent.subscribe((event, signal) => ...)      // awaited, in order (:275)
await agent.prompt("text" | msg | msg[]);     // throws if already running (:382)
agent.steer(msg); agent.followUp(msg);        // queue (:308, :313); modes "all"|"one-at-a-time"
agent.abort(); await agent.waitForIdle();     // (:350, :359)
await agent.continue();                       // retry from user/toolResult tail (:393)
agent.reset();
```

`AgentOptions` (`:115-150`) also takes `getApiKey`, `onPayload`, `thinkingBudgets`, `transport`, `sessionId`, `identity` (default attribution `PI_ATTRIBUTION`; pass `{attribution:null}` to drop). `streamFn` is the only provider coupling and may be `streamProxy(...)` to route through a server that holds the keys (`proxy.ts`, README "Proxy Usage").

### 3.4 Interruption and steering

- **Abort**: `agent.abort()` aborts the active run's `AbortSignal`, passed to model streaming and to each `tool.execute(..., signal)` (`agent.ts:345-357`). Hooks receive the signal and must honor it.
- **Steering**: `steer()` messages are drained after the current assistant turn finishes executing its tool calls (tool calls of that message are not skipped); `followUp()` messages only when the agent would otherwise stop (README 390-428; `types.ts:282-306`). `Agent.prompt()` while running throws; use steer/followUp.
- **Early stop**: `terminate: true` from a tool/hook stops after the batch only if all results in the batch set it (`types.ts:66-74`, `:445`); `finishTurn` can `{action:"end"}`.

Gaps relative to a server: no persistence, no retry/compaction, no crash recovery. Those are in coding-agent (`AgentSession`) or durable.

---

## 4. packages/coding-agent (the `pi` CLI + SDK)

### 4.1 Built-in tools (`src/core/tools/`)

- Names: `read, bash, powershell, edit, write, grep, find, ls` (`tools/index.ts:95-105`). **Default active set is only `read, bash, edit, write`** (`createCodingTools` `:195-202`; `system-prompt.ts:64`; `docs/cli.md` "Default enabled tools"). `grep/find/ls` form `createReadOnlyTools` (`:204-211`). `powershell` is Windows-oriented.
- `read`: text and images (jpg/png/gif/webp/bmp), truncated to `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES` (2000 lines / 50KB by the description format, `read.ts:239`), `offset`/`limit` params. `bash`: `{command, timeout?}`, combined stdout+stderr, tail-truncated with the full output spilled to a temp file (`bash.ts:40, 283`). `edit`: exact text replacement(s) (`edit.ts`, `edit-diff.ts`). `write`: create/overwrite (`write.ts`). All file mutations go through `withFileMutationQueue` (`tools/file-mutation-queue.ts`) because tool calls are parallel by default. Tools strip a leading `@` from paths.
- Each tool exposes **pluggable `Operations`** (`ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `FindOperations`, `GrepOperations`; `bash.ts:74-98`, `read.ts:53`, `write.ts:26`, `edit.ts:78`) so execution can be delegated to SSH/containers; `BashToolOptions.spawnHook` adjusts command/cwd/env (`docs/extensions.md` "Remote Execution", 2391-2449). Grep always runs local `rg` (only a directory check is pluggable).
- Bash tool exports `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` to commands unless `exposeSessionEnvironment:false` (`docs/extensions.md:2447`).
- Optional built-in extensions (off by default): `codemode` and `tool_search`; MCP tools are exposed through them (`docs/cli.md:140-160`).

### 4.2 System prompt (`src/core/system-prompt.ts`)

Structured into named sections, each wrapped in an XML-ish tag except `preamble`: `preamble` ("You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.", `:155-156`), `tools` (one-line snippets, `:157-160`), `rules` (tool guidelines + "Be concise" + "Show file paths clearly", `:88-125`), `docs` (paths to Pi's own docs, `:162-168`), `addendum` (append text), `project_context` (`<project_instructions path=...>` for context files), `skills`, `cwd`, then extension `sections` (`:128-192`). `customPrompt` replaces the preamble+tools+rules+docs block; `forceSystemPrompt` replaces everything (`:15, 202`). The prompt is stored as a `SystemMessage` with `sections`; later changes are section patches (`diffSystemPromptSections` `:216-228`), preserving cache.

Prompt sources: `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` (project, trust-gated) and `~/.pi/agent/SYSTEM.md|APPEND_SYSTEM.md` (`core/resource-loader.ts:1254-1273`). Context files: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` walked up from cwd and loaded regardless of project trust (`resource-loader.ts:215`; `docs/security.md`). So **CLAUDE.md / AGENTS.md are honored natively**; `examples/extensions/claude-rules.ts` also exists.

### 4.3 Sessions

- JSONL tree files at `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl` (`docs/session-format.md:8-13`); custom id via SDK or `--session-id`; `SessionManager.create/open/continueRecent/inMemory` (`session-manager.ts:1775-1824`), `CURRENT_SESSION_VERSION = 3` (`:41`).
- Entries have `id`/`parentId` forming a tree; the "current leaf" selects the active branch; branching in place, `fork`/`clone` copy to a new file. Entry types: header (`type:"session"`, `cwd`, `parentSession?`), `message` (any `AgentMessage`, incl. system messages carrying prompt+tool declarations), `model_change`, `thinking_level_change`, `usage`, `compaction` (`summary`, `firstKeptEntryId`, `tokensBefore`, `systemMessage` checkpoint, `details.readFiles/modifiedFiles`), `branch_summary`, `custom`/`custom_message`, `label`, `session_info`, context edit entries (`docs/session-format.md`).
- Compaction: automatic on threshold/overflow, plus manual `/compact`; summary format (Goal / Constraints / Progress / Key Decisions / Next Steps) (`docs/compaction.md`). Auto-retry with backoff on provider errors (`auto_retry_start` event, `agent-session.ts:235`).
- The session file is the authoritative context; "assigning `session.agent.state.messages` does not replace persisted context" (`docs/sdk.md`). Sessions can contain secrets; review before sharing.

### 4.4 Extensions, skills, hooks, prompt templates, packages

- **Extensions**: TypeScript modules (loaded with jiti, `core/extensions/loader.ts`) exporting `default function (pi: ExtensionAPI)`. Locations: `~/.pi/agent/extensions`, `.pi/extensions` (trust-gated), `-e path`, installed Pi packages (`docs/extensions.md:123-155`). They run **inside the Pi process with full privileges** (`docs/how-pi-works.md` "Trust and permissions").
- `ExtensionAPI` (`core/extensions/types.ts:1638+`): `on(event, handler)`, `registerTool` (`ToolDefinition`, `:600`), `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider` (`:1907`), `registerVirtualModel` (`:1960`), `registerMcpServer` (`:1943`), `sendMessage`, `sendUserMessage` (`:1790`), `appendEntry`, `setActiveTools`, `setModel`, `exec`, `events` bus, message/entry renderers, `getSettings`.
- **Events** (`docs/extensions.md:307-1160`): startup `project_trust`, `resources_discover`, `mcp_servers_change`; session `session_start`, `session_before_switch|fork|compact|tree`, `session_compact`, `session_shutdown`; agent `before_agent_start` (inject message or **replace system prompt**, `types.ts:1517-1520`), `agent_start|end`, `agent_before_settle`, `agent_settled`, `turn_start|end`, `message_start|update|end`, `tool_execution_*`, `context` / `context_with_system` (rewrite messages before each LLM call), `before_provider_headers`, `before_provider_request` (rewrite payload), `after_provider_response`, `provider_stream_event`, `cache_warming_decision`; `model_select`, `thinking_level_select`; **`tool_call`** (block / mutate `event.input` in place, `ToolCallEventResult` `types.ts:1475-1483`) and **`tool_result`** (patch `content/details/isError/usage`), `user_bash`, `input` (transform/handle user input).
- **Skills**: Agent Skills spec; directory with `SKILL.md` frontmatter (`name`, `description`, `disable-model-invocation`); only name/description/path go into the system prompt, model `read`s the file on demand; `/skill:name` forces (`docs/skills.md`). Project skills `.pi/skills`, `.agents/skills` need trust.
- **Prompt templates** (`docs/prompt-templates.md`), **themes**, **Pi packages** (npm/git bundles of extensions+skills+templates, `pi install`, `core/package-manager.ts`).
- **Slash commands**, `!cmd` user-bash, `/tree`, `/fork`, `/compact`, `/login`, `/model`, `/mcp`, etc. are interactive features.

### 4.5 Permission model — does Pi ask before running tools?

**No.** Stated in several places:
- Root `README.md` "Permissions & Containerization": "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it."
- `packages/coding-agent/docs/security.md:3`: "it does not ask for approval before every tool call."; "Watching the transcript, using project trust, and reviewing changes do not create a security boundary." `SECURITY.md` classifies lack of a sandbox and prompt injection as out of scope.
- I found no `canUseTool`/permission-mode/allow-ask-deny rules in `coding-agent/src` (only `_allowedTools`, a tool-name allowlist, `agent-session.ts:486,540`).

What does exist:
- **Tool allow/deny by name**: `--tools`, `--exclude-tools`, `--no-builtin-tools`, `--no-tools`, SDK `tools`/`excludeTools`/`noTools`/`customTools` (`docs/cli.md:113-140`, `sdk.ts:71-94`). E.g. read-only = `createReadOnlyTools`.
- **Project trust** (`core/trust-manager.ts`, `core/project-trust.ts`, `docs/security.md` "Understand project trust"): gates *loading* of `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`, `.agents/skills`. Decision order: `--approve`/`--no-approve` flag, `project_trust` extension event, saved decision in `~/.pi/agent/trust.json`, then `defaultProjectTrust` (`ask` default; non-interactive modes cannot prompt so `ask`/`never` skip protected resources unless `always`). It does not constrain what tool calls can do.
- **Opt-in gates via extensions**: `tool_call` handler returning `{block:true,reason}` (`docs/extensions.md:973-1013`); example `examples/extensions/permission-gate.ts` (dangerous bash patterns; asks with `ctx.ui.select`, blocks by default when `!ctx.hasUI`), `confirm-destructive.ts`, `protected-paths.ts`, `dirty-repo-guard.ts`, `plan-mode/`.
- **Sandboxing is external**: Docker, Docker Sandboxes (proxy-substituted credentials), OpenShell, or the Gondolin extension (below) (`docs/containerization.md`).

### 4.6 Programmatic / headless use

Four modes, "all use the same agent, sessions, resources, and tools" (`docs/cli-integration.md:3-9`):

1. **Print** `pi -p "..."` — final text only; nonzero exit on `error`/`aborted`/`length` stop reason (`cli-integration.md:25-31`; `modes/print-mode.ts:34`). Non-TTY auto-selects print.
2. **JSON** `pi --mode json "prompt"` — session header + JSONL events for one invocation (`docs/json.md`). Events = agent events (`agent_start/end`, `turn_*`, `message_*` with `assistantMessageEvent` deltas, `tool_execution_*`) plus session events (`queue_update`, `compaction_start/end`, `auto_retry_*`, `agent_settled{aborted}`) (`agent-session.ts:210-254`). `agent_end` != done: wait for **`agent_settled`**.
3. **RPC** `pi --mode rpc [--no-session]` — long-lived JSONL over stdin/stdout (`docs/rpc.md`, `modes/rpc/rpc-mode.ts:55`). Commands (`modes/rpc/rpc-types.ts:22-55+`, `docs/rpc-commands.md`): `prompt` (with `streamingBehavior: steer|followUp`, images), `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`/`abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`. Responses carry optional `id`; a `prompt` success response means *accepted*, not done (`rpc.md` "Run lifecycle"). Strict LF framing (do not use Node `readline`). Stdin EOF/SIGTERM = orderly shutdown. **Extension UI sub-protocol** (`docs/rpc-extension-ui.md`): `select`, `confirm`, `input`, `editor` emit `extension_ui_request` on stdout and block until the client answers `extension_ui_response` (optional `timeout` auto-resolves); `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` are fire-and-forget. In RPC mode `ctx.hasUI === true` and `ctx.mode === "rpc"`. This is how a permission gate or an ask-user tool can reach a remote client with stock Pi. TS client: `RpcClient` (`modes/rpc/rpc-client.ts:56`, exported `src/index.ts:429`; `promptAndWait()`; `examples/rpc-client.ts`).
4. **SDK** (in-process): `createAgentSession({cwd, agentDir, modelRuntime, model, thinkingLevel, tools, excludeTools, noTools, customTools, resourceLoader, sessionManager, settingsManager})` (`core/sdk.ts:48-106`) -> `AgentSession` with `prompt()` (`agent-session.ts:2177`; must say steer/followUp if streaming), `steer()`, `followUp()`, `abort()` (`:2616`), `waitForIdle()` (`:2628`), `subscribe()` (`:1457`), `setModel()`, `compact()`, `bindExtensions()` (`:3428`), `dispose()` (`:1481`). `AgentSessionRuntime` swaps sessions (`newSession/switchSession/fork`). `SessionManager.inMemory()` for no files. SDK sessions do not load the CLI's built-in codemode/tool_search/MCP extensions; add `createCodemodeExtension()`, `createToolSearchExtension()`, `createMcpExtension()` (`docs/sdk.md` "Configuring a session"). Examples in `examples/sdk/01-14`. Credentials via `ModelRuntime` / `auth.json` / env.

Driving it from a server: practical options are (a) spawn `pi --mode rpc` per session in a sandbox and bridge JSONL to a websocket (process isolation; extensions-with-UI work through the sub-protocol), (b) embed `createAgentSession` in a Node worker with a custom `SessionManager`/`ModelRuntime`/`CredentialStore`, or (c) skip coding-agent entirely and use pi-durable (below). Config is heavily file-based (`~/.pi/agent`, `.pi/`), single-user and cwd-centred; multi-tenant hosting means one process/home dir per tenant.

### 4.7 How pi-durable relates to coding-agent

- **No code dependency in either direction**: coding-agent does not list `pi-durable`; durable does not list `pi-agent-core`/`pi-coding-agent` (package.json files above; grep of `durable/src`).
- Durable **replaces the session layer and the loop**, with a different model: conversations, model turns, tool calls, inputs are committed to storage (chord documents over memory/JSONL/SQLite/IndexedDB/Cloudflare SQLite: `durable/src/storage/*`) *before* being shown; a crash mid-turn resumes from storage (`durable/README.md:5-6`). Tool calls are durable tasks with `replay: "safe"|"never"` (`README.md:336`; the same `replay` field exists on `AgentTool`, `agent/src/types.ts:502`).
- It **re-implements the coding tools**: `durable/src/tools/{read,write,edit,bash}.ts` + `CodingTools` extension (`README.md:294-296`), written against pi-schema (`tools/bash.ts:1-14` "as the tools accepted extra arguments when their schemas were TypeBox's"), so they are API-compatible copies of coding-agent's tools but run through an `ExecutionEnv` (`durable/src/env/index.ts:230-377`: `FileSystem` + `Shell`, `exec(command|argv, {cwd, env, timeout, onOutput, spill, window}, context)`; `cleanup()`), not directly through `node:fs`. `NodeExecutionEnv` (`@earendil-works/pi-durable/env/node`) is the local implementation; `pi-env`'s `RemoteExecutionEnv` is the SSH/daemon one.
- Durable has its own **extension model** (named extensions with `tools`, `sections` (system prompt), `hooks`, `wraps`, `tasks`; `README.md` "Extensions", "System Prompt", "Hooks"), its own **codemode** extension (`durable/src/codemode`), its own **tool-search** (`durable/src/tool-search`), compaction (`durable/src/harness/compaction.ts`), subagents as owned child conversations (`README.md` "Abort and Subagents"), and examples that mirror coding-agent features (`test/examples/25-coding-agent.ts`, `26-plan-mode.ts`, `21/22-subagent-*`, `44-approval-gate.ts`, `39-ask-a-person.ts`, `28-sandbox-per-conversation.ts`). These are the closest existing code to "Claude Code on the web" semantics.
- Practical read: coding-agent is the reference for **tool behavior, prompt wording, session JSONL format, RPC protocol**; durable is the substrate to build a **hosted, restartable, multi-conversation** harness on.

---

## 5. packages/env, codemode, mcp: environment, sandboxing, MCP

### 5.1 Environment abstraction

- The environment contract is durable's `ExecutionEnv extends FileSystem, Shell` (`durable/src/env/index.ts:377`): `readFile/openBinaryReader/writeFile/appendFile/truncateFile/renameFile/fileInfo/listDir/listFiles?/openDirReader/watch/canonicalPath/exists/createDir/remove/createTempDir/createTempFile/cleanup` plus `exec`. All results are `Result<T, FileError|ExecutionError>`; every call takes a chord `Context` (cancellation/telemetry). `id` identifies "same files at same paths" for edit/write serialization (`durable/README.md:545`).
- Durable harness option `env: ({conversationId, cwd, ...}) => ExecutionEnv` is called per tool call/section render, so one function can give a directory per conversation or a container per conversation (`README.md:531-545`); without an env, built-in tools return error results.
- `NodeExecutionEnv` (local), `LocalExecutionEnv` (Node + daemon-backed `listFiles`), `RemoteExecutionEnv` (`env/src/remote-env.ts`) which talks to the **`pi-env` Rust daemon** (`env/daemon`, protocol in `env/docs/protocol.md`, semantics parity with Node in `env/docs/semantics.md`) deployed over SSH with strict host-key checking, `BatchMode`, no forwarding/shared connections (`env/README.md:17-34`, `src/ssh.ts`). Linux/macOS/Android(Termux)/Windows, x64/arm64. Extras: `openTerminal` (pty), `openProcess` (pipes; used to host MCP servers remotely via `PipeTransport`), `RemoteWatcher`.
- `Connection` is transport-agnostic (`env/src/connection.ts`, options take a `command: [...]` to spawn), so a harness could run the daemon via `docker exec`/`kubectl exec`/a microVM agent instead of ssh by supplying its own `Connection` command (inference from `new Connection({ command: [localDaemon()] })`, `env/README.md:47`; not demonstrated in the repo for non-SSH remotes).

### 5.2 Sandboxing story and Gondolin

- Core Pi has **no sandbox** (see 4.5). `CHANGELOG.md:345` of coding-agent: "Removed the native OS `sandbox/` extension example... Use the Gondolin example or the containerization guide."
- **Gondolin** (`@earendil-works/gondolin`, "QEMU with KVM, host-side network policy", `apps/p2/docs/remote-envs.md:41`) is referenced in:
  - `README.md` (root) "Permissions & Containerization": Gondolin extension keeps `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
  - `packages/coding-agent/examples/extensions/gondolin/index.ts` (528 lines): mounts host cwd at `/workspace` via `RealFSProvider`, implements Read/Write/Edit/Bash/Find/Grep/Ls operations against the VM; needs Node >= 23.6 and QEMU (`:1-20`). Workspace package in root `package.json` workspaces. Doc table in `docs/containerization.md`: tool isolation only; stored credentials stay on host but commands inherit host env.
  - `apps/p2/plugins/envs/{sandbox-host.ts,sandbox/p2-sandbox.sh,remote-env.ts,secrets.ts,...}` and `apps/p2/docs/remote-envs.md:41-100`: sandboxes = Gondolin VMs on an SSH environment, disk resize, `allowHosts` HTTP(S) allowlist, secrets injected as Gondolin placeholders. `packages/chord/docs/p3-features/book.md:400` lists `HarnessEnvironments (ssh, gondolin, hands as kinds)`. (These are covered by other agents; included for the grep answer.)
- Other documented boundaries: plain Docker image (`node:24-bookworm-slim` + `pi` + ripgrep), Docker Sandboxes (`sbx`, proxy substitutes secrets, Pi kit), OpenShell (`docs/containerization.md`). The codemode VM is a real capability sandbox (no `fetch`, timers, `process`, `require`; only injected tools; memory and timeout limits; `codemode/README.md:44-56`), but that sandboxes model-written scripts, not tools.

### 5.3 pi-codemode

`CodemodeSandbox.execute(code)` returns `{ok, value, output[], calls[], error}`; scripts get `tools.<name>()`, `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()/load()`, `console.*`, optional `// @options:` header (`codemode/README.md`, `src/types.ts`, `src/runtime/execution.ts`). Nested tool calls never enter LLM context. Runs on worker thread (Node/Bun), inline, or a remote DO (Cloudflare). In coding-agent: `src/extensions/codemode/` (tool, renderer); `docs/codemode.md`; default declaration budget 3000 estimated tokens (`docs/codemode.md:50`). Also exposes non-LLM models (classifiers, image generation) to scripts. Durable ships its own `codemode` extension reusing the same package.

### 5.4 pi-mcp and MCP in the agent

- Client: `McpClient({name, version, roots})`, `connect(transport)`, `listTools/callTool` (README usage; `src/client.ts`). Transports: `StdioTransport` (spawns locally, cross-spawn), `StreamableHttpTransport({url, headers, fetch})`, `PipeTransport({open})` for programs started elsewhere (pi-env `openProcess`), in-memory for tests. OAuth: `@earendil-works/pi-mcp/oauth` (discovery RFC 9728/8414, DCR or Client ID Metadata Document, PKCE, token refresh; `src/oauth/*`).
- In coding-agent: built-in MCP extension (`src/extensions/mcp/index.ts`, 1345 lines). Config `~/.pi/agent/mcp.json` + project `.pi/mcp.json` (trust-gated), Claude-Desktop-compatible `mcpServers` format with `command/args/env/cwd` or `url/headers/oauth`, `timeout`, `enabled`, `exposure`; env interpolation `${VAR}` and `!command` (`docs/mcp.md`). Tools named `mcp__<server>__<tool>`; **exposure modes** `codemode` (default: callable only from codemode scripts, not declared), `deferred` (loaded by `tool_search`), `direct` (declared like built-ins), `hidden`. OAuth tokens in `~/.pi/agent/mcp-auth.json`. Extensions can `pi.registerMcpServer()` at runtime (`types.ts:1943`). Docs state "Pi registers as `pi`" with an optional `clientName` override (docs/mcp.md OAuth section).
- Agent-core example `packages/agent/examples/mcp-codemode` wraps MCP tools as `AgentTool`s and runs codemode via `runToolCall()` so hooks apply to nested calls.
- Durable has no MCP code; apps/p2 does (`apps/p2/package.json:31`).

---

## 6. Extension points relevant to a remote harness

| Need | coding-agent mechanism | durable mechanism (preferred for a hosted service) |
|---|---|---|
| Custom tools | `pi.registerTool(ToolDefinition)` (`extensions/types.ts:600`); SDK `customTools`; `execute(id, params, signal, onUpdate, ctx)`; override built-ins by same name (`docs/extensions.md:2358-2376`), `--no-builtin-tools` | `defineTool({name, description, parameters, execute(args, api, context), replay, structuredOutputSchema})` in a `defineExtension({tools})`; `registry.install()` (`durable/README.md:319-336`) |
| Custom model providers | `pi.registerProvider(name, config)` / full `Provider` (`types.ts:1907`), `models.json`, `examples/extensions/custom-provider-anthropic`, `custom-provider-gitlab-duo`; virtual models/routers (`docs/virtual-models.md`) | pass a `Models` collection (`Harness.open(storage, {models, registry}, context)`); any pi-ai `createProvider()` (README `Quick Start`); `ProviderDoc` stores provider state (`durable/src/harness/provider.ts`) |
| System prompt injection | `before_agent_start` -> `systemPrompt`/message (`types.ts:1517`); `.pi/SYSTEM.md`, `APPEND_SYSTEM.md`; SDK `resourceLoader` (context files, prompt overrides); `sections` (`system-prompt.ts:30`); `promptSnippet`/`promptGuidelines` per tool | `section(name, (input)=>text, {tag})` in an extension; conversation `instructions` render last (`README.md` "System Prompt") |
| Hooks around tool execution | `tool_call` (block/mutate input), `tool_result` (patch result), `tool_execution_*` events; low level `beforeToolCall`/`afterToolCall` in agent-core (`agent/src/types.ts:326,341`); `BashToolOptions.spawnHook` | `hook(ToolTask, {beforeTool, afterTool})`; `hook(GenerationTask, {beforeRequest, beforeProviderRequest, afterResponse, onYield, afterTools, afterRun})`; `wraps` to decorate tools/sections by name (`README.md` "Hooks") |
| Approval / human-in-the-loop | `ctx.ui.select/confirm/input/editor` inside `tool_call` handler or a tool (`permission-gate.ts`); over RPC becomes `extension_ui_request`/`response` (`docs/rpc-extension-ui.md`); blocking in-process, no durability (process death loses the pending question) | `beforeTool` may return `{sleep: {signals, until}}` to **park** the call until a signal (e.g. approval) arrives, holding no process (`README.md` "Gates before a tool runs", `test/examples/44-approval-gate.ts`) |
| Ask-user / question tools | `examples/extensions/question.ts`, `questionnaire.ts`, `qna.ts` (TUI-rendered, built on `ctx.ui`; `custom()` UI is not available over RPC, `rpc-extension-ui.md` Limitations) | `test/examples/39-ask-a-person.ts`: a task asks a person and sleeps until answered or deadline; signals (`38-signals.ts`) |
| Sub-agents | **Not built in** ("skips features like sub-agents and plan mode", README). Example `examples/extensions/subagent/` spawns separate `pi` processes with agent definitions (`scout/planner/reviewer/worker.md`) | Owned child conversations: `createConversation({ownership:{kind:"task",taskId}})`, `api.conversation(id).submit()`; abort propagates; background anchors; examples `21`, `22`, `42-parallel-children`, `43-subagent-waits` |
| Plan mode | Not built in; `examples/extensions/plan-mode/` | `test/examples/26-plan-mode.ts` |
| MCP | built-in extension + `mcp.json`, `pi.registerMcpServer` | none built in; one extension per MCP server with a `namespace` is the pattern (`README.md:467`), wired with `pi-mcp` yourself |
| Execution environment / sandbox | `*Operations` overrides, `spawnHook`, Gondolin/ssh examples (`examples/extensions/ssh.ts`) | `env` function per conversation returning an `ExecutionEnv`; `RemoteExecutionEnv`; `28-sandbox-per-conversation.ts` |
| Context management | `context` event, `transformContext`, compaction events/custom compaction (`examples/extensions/custom-compaction.ts`), `ctx.compact()` | `beforeRequest`; `compaction.ts`; `24-compaction.ts` |
| Skills | `SKILL.md` discovery, `/skill:name` | not built in; implement as an extension section + `read` tool (inference) |
| Usage/cost | `usage-totals.ts`, `get_session_stats` RPC | `harness.usage(context)`; tool-reported `usage` |
| Telemetry | `core/telemetry.ts` (13 lines) | `DURABLE_TELEMETRY_SCHEMA`, chord/telemetry contexts |

Server-relevant pi-ai extension points independent of agent layer: `onPayload`/`transformHeaders`/`fetch` injection (route all provider traffic through our egress/proxy and meter it), `CredentialStore` injection, `identity.attribution`, `pi-messages` API for talking to a house gateway, and `models.refresh()` with a `ModelsStore` for dynamic catalogs.

---

## 7. Philosophy differences vs Claude Code (as stated in code/docs)

1. **Minimal, opinionated-by-omission.** "Pi is a minimal, extensible agent harness that you can make your own... skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package" (root `README.md`, `coding-agent/README.md`). Default tools are four (`read, bash, edit, write`); `grep/find/ls` are opt-in (`docs/cli.md`). There is no Task/sub-agent tool, no TodoWrite, no WebFetch/WebSearch, no NotebookEdit, no plan mode, no AskUserQuestion, no hooks config file in the Claude Code style, no slash-command markdown registry beyond prompt templates/extensions in core; all are extension territory (`examples/extensions/{subagent,plan-mode,todo,question,...}`).
2. **No permission system.** Claude Code's default is ask/allow/deny per tool with modes; Pi's default is run everything as the user (`README.md` Permissions; `docs/security.md:3`). Approval is a pattern you add (extension `tool_call` hook; durable `beforeTool` + park). For a Claude-Code-cloud-like product, the sandbox (VM/container + egress policy) is the security boundary, and an approval UX must be built. Claude Code's permission prompts, allowlists and "accept edits" modes have no equivalent to port.
3. **Project trust instead of tool trust.** Trust controls loading of project-supplied code/config (`.pi/*`, `.agents/skills`), asked once per directory and cached in `trust.json`; non-interactive default skips them unless `defaultProjectTrust: "always"` (`docs/security.md`). Context files (`AGENTS.md`, `CLAUDE.md`) always load. In a cloud product that clones arbitrary repos, decide this explicitly (probably `--no-approve` / never, or per-repo policy).
4. **Extensions are in-process code, not config.** Hooks are TypeScript event handlers with full process privileges; no declarative settings.json hooks. Skills follow the shared Agent Skills spec (compatible with Claude skills layout), MCP config is Claude-Desktop-compatible (`docs/mcp.md` migration table), so existing `mcpServers`/`SKILL.md`/`CLAUDE.md` assets port; slash commands/hooks/subagent markdown do not.
5. **Context engineering is explicit and cache-aware.** System prompt as named sections patched mid-conversation; tool set changes as system messages; cache-warming policy; Anthropic message threads; model-specific thinking-level maps (`ai/src/types.ts:565-587`; `system-prompt.ts:127-228`; `ai/src/cache-warming.ts`). MCP/large toolsets handled through `codemode`/`tool_search` exposure rather than declaring every tool (`docs/mcp.md` exposure table), which differs from Claude Code's "all MCP tools in context" default.
6. **Provider-neutral and local-first.** 43 providers, subscription OAuth for several (including Claude Pro/Max), sessions as local JSONL trees that can branch (`/tree`), session sharing to Hugging Face is encouraged (root README "Share your OSS coding agent sessions"). Claude Code is Anthropic-only with server-side features. Pi's Anthropic OAuth path mimics Claude Code (headers, tool names, system line; see 2.3), which is a dependency on Anthropic tolerating that; API-key or workload-identity-federation auth is the stable route for a hosted product.
7. **Persistence model.** coding-agent: single-user local files, cwd-keyed. Durable: transactional storage, crash-resumable tool tasks, multiple conversations/forks, waiting/parking on signals and timers (`durable/README.md` intro, "Crash loops" note at :265). Durable is what makes a "run in the cloud, come back later" product feasible; the CLI is not designed for that.
8. **Stability.** Durable is marked "Experimental. The API changes without notice between releases" (`durable/README.md:3`); AGENTS.md says "Do not preserve backward compatibility unless the user asks" (`AGENTS.md` Code Quality). Pin exact versions (the repo's own supply-chain stance: exact-pinned deps, `package-lock.json`, `--ignore-scripts`; root README "Supply-chain hardening"). Node >= 22.19 required (root README). New-contributor issues/PRs are auto-closed (`README.md`, `CONTRIBUTING.md`), so expect to fork/patch rather than upstream quickly.

### Suggested building blocks for a cloud Pi harness (derived, not stated in repo)

- Core: `pi-durable` Harness (storage: SQLite/Store) + `pi-ai` `Models` with a DB-backed `CredentialStore` (Anthropic API key / WIF; subscription OAuth only if policy allows) + `pi-durable/tools` `CodingTools` + custom `env` function returning a per-conversation sandbox `ExecutionEnv` (`pi-env` `RemoteExecutionEnv` pointed at a microVM/container, or Gondolin as p2 does).
- Safety: sandbox boundary + egress allowlist (Gondolin `allowHosts` pattern, `apps/p2/docs/remote-envs.md:73`); approvals via `beforeTool` park + signal; keep `bash` tool but consider read-only tool sets for review conversations.
- Product features Claude Code users expect that must be authored: AskUserQuestion (durable task + signal), subagents (owned child conversations), todo/plan mode (extension docs/hooks), MCP (pi-mcp via `PipeTransport` inside the sandbox through `openProcess`, so servers run where the code runs), CLAUDE.md/AGENTS.md discovery and skills loading (copy logic from `coding-agent/src/core/resource-loader.ts:215` and `skills.ts`, reading through the `ExecutionEnv`), git/PR integration (just `bash` + MCP).
- Alternative short path to a demo: run `pi --mode rpc` (or SDK `createAgentSession`) per task inside a sandbox VM and relay JSONL events over a websocket; add a `tool_call` gate extension using `extension_ui_request` for approvals. Loses durability and multi-tenancy, but works with stock Pi and gets compaction, skills, MCP and AGENTS.md for free.

### Open questions / not verified

- Whether `pi-env`'s `Connection` is intended for non-SSH transports (it accepts a spawn `command`; only SSH and local daemon are exercised in repo).
- Exact terms/risk of shipping Anthropic subscription OAuth in a hosted service (code mimics Claude Code; no policy text in repo).
- The `Harness` public API surface (durable internals) was only read at README level here.
