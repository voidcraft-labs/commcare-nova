# Nova MCP — infra changes

## Cloud Run domain mappings

Before the MCP endpoint can be exercised end-to-end, two new domain mappings
must be configured on the existing Cloud Run service:

    mcp.commcare.app  → nova service (region: us-central1)
    docs.commcare.app → nova service (region: us-central1)

These are domain mappings on the same service, not separate services —
proxy.ts splits them. Set via the GCP console (Cloud Run → domain
mappings) or gcloud:

    gcloud beta run domain-mappings create \
      --service nova \
      --domain mcp.commcare.app \
      --region us-central1

    gcloud beta run domain-mappings create \
      --service nova \
      --domain docs.commcare.app \
      --region us-central1

DNS: add CNAMEs on commcare.app pointing both subdomains at
`ghs.googlehosted.com.` (GCP's managed cert host). Cert provisioning takes
a few minutes. Verify with:

    curl -I https://mcp.commcare.app/mcp
    curl -I https://docs.commcare.app/

Both should return a valid TLS handshake and a Cloud Run response.

## Dynamic agent discovery probe (2026-04-23)

**Probe (Phase H):** plugin skill mints `RUN_ID`, resolves plugin root via
`${CLAUDE_SKILL_DIR}/../..` (template substitution, not a shell env var — the
shell-env form `$CLAUDE_SKILL_DIR` the original plan sketch used is unset),
writes `probe-agent-<runId>.md` to `<plugin-root>/agents/`, invokes
`Agent(subagent_type: "nova-probe:probe-agent-<runId>")`. Also tested
overwriting an existing file mid-session and the `~/.claude/agents/`
fallback.

**Outcome: fourth case, not A/B/C.** Mid-session discovery of *new* agent
files fails AND mid-session overwrites of *existing* agent files fail.
Both plugin-dir and `~/.claude/agents/` behave identically. `/reload-plugins`
is a `LocalCommandCall` — the Skill tool refuses to invoke it ("reload-plugins
is a built-in CLI command, not a skill") and no Bash/Write escape hatch lands
on `refreshActivePlugins`, so no programmatic workaround exists.

**Source-code root cause** (`~/Desktop/claude_code`, 2.1.119):

- `loadAgentsDir.ts:713` reads `const systemPrompt = content.trim()` once at
  parse time; `:726` stores `getSystemPrompt: () => systemPrompt + memoryPrompt`
  — a closure over that literal string, not a fresh disk read.
- `loadAgentsDir.ts:296` wraps the whole loader in lodash `memoize` keyed by
  `cwd`, so repeat calls return the same `AgentDefinition[]` — no re-scan.
- `utils/plugins/refresh.ts:refreshActivePlugins` is the only invalidator
  (`clearAllCaches` + `clearAgentDefinitionsCache`); called only from interactive
  `/reload-plugins` (`commands/reload-plugins/reload-plugins.ts:37`), the
  print-mode startup path, and background-install completion. None of those
  is reachable from a skill body.
- `runAgent.ts:915` looks up `agentDefinition.getSystemPrompt()` on the frozen
  snapshot stored in `toolUseContext.options.agentDefinitions`, and bodies have
  no template expansion — `:918` just appends env details.

**Impact on Phase I:** drop the mint-runId → write → spawn pattern entirely.
Two replacements considered:

1. **Shell out to `claude --print --agents <json>`.** Works (verified: inline
   agent definitions via `--agents` JSON are picked up at child-session start)
   but spawns a nested CLI, forfeits progress-notification flow-back, and
   forces OAuth/MCP-token propagation into the child session. Heavier than the
   problem warrants.
2. **Static bootstrap + server self-fetch.** Plugin ships two static agents
   (`nova-architect-interactive`, `nova-architect-autonomous`) with frontmatter
   that bakes in tool restrictions. Each body is a short bootstrap instructing
   the agent to call `mcp__nova__get_agent_prompt(mode, interactive, app_id?)`
   as its first action and follow the returned `system_prompt` as its full
   operating instructions. The skill just spawns; the agent self-fetches on
   every run so the server stays the authoritative source for prompt text
   without plugin releases.

Chosen: **option 2 (static bootstrap + self-fetch).** Simpler skills, no
subprocess, preserves server-as-source-of-truth for the body text. The only
iteration that now requires a plugin release is frontmatter fields
(`model`, `effort`, `tools`, `disallowedTools`) — which rarely change.

**Related code-cleanup triggered:** `get_agent_prompt` previously returned
`{ frontmatter, system_prompt }`. With the self-fetch pattern the frontmatter
field is unused — per the project rule against dead paths it's being dropped
from `lib/mcp/prompts.ts`, `lib/mcp/tools/getAgentPrompt.ts`, their tests,
Phase F's plan contract, and Phase I's orchestration section.

**Probe cleanup:** `~/scratch/{env,agent,nova}-probe` scratch dirs and any
stray `~/.claude/agents/probe-*.md` left by intermediate probes are removed
at the end of Phase H.

## Plugin smoke test (2026-04-23, localhost)

Smoke tested the plugin at `~/work/personal/code/nova-plugin/` against the
dev server at `http://localhost:3000/api/mcp` via a local marketplace at
`~/work/personal/code/nova-marketplace/` (symlinked `./nova-plugin` →
`../nova-plugin`, `source: "./nova-plugin"` per `RelativePath().startsWith('./')`
in `utils/plugins/schemas.ts:162`). Plugin installed `nova@nova-local`,
OAuth completed against the plugin-scoped server `plugin:nova:nova`.

- `/nova:list`: **pass**. Inline skill calls the read tool, returns a
  markdown table of the user's apps.
- `/nova:show <app_id>`: **pass**. Inline skill renders the blueprint
  summary returned by the read tool.
- `/nova:ship "a simple patient registry capturing name, date of birth,
  and village"`: **pass**. Spawned `nova:nova-architect-autonomous` via
  Agent tool, subagent bootstrap-fetched the autonomous operating
  instructions from `get_agent_prompt`, ran the full pipeline
  (`create_app` → `generate_schema` → `generate_scaffold` → `add_module`
  → `add_fields` → `validate_app`), validation passed first try. Produced
  app_id `MP8stWsvgFDLW0hopZx5`. `AskUserQuestion` confirmed blocked at
  the tool-permission layer (autonomous agent's `disallowedTools`).
  Duration ≈ 75s. Design decisions reported in the final summary.
- `/nova:build`: **skipped under `--print`**. Requires interactive
  `AskUserQuestion` surfacing which the non-interactive transport can't
  deliver. Same plumbing as `/nova:ship` minus the tool-level block, so
  it's covered by the interactive-mode probe below.
- `/nova:edit <app_id> "add a phone_number text field to the Register
  Patient form"`: **pass**. Spawned `nova:nova-architect-interactive`,
  subagent's bootstrap fetch returned the edit-mode prompt with the
  blueprint summary inlined (no separate `get_app` round-trip), applied
  `add_field`, validated, reported the modified summary. Duration ≈ 31s.
- Event log run_id grouping: **broken by design, not by bug.** Each
  tool call got a fresh `run_id` in the event log (`inspect-logs.ts`
  showed 6 distinct runs for one `/nova:ship`). Root cause:
  `services/mcp/client.ts:1841` sets `_meta = { 'claudecode/toolUseId':
  toolUseId }` unconditionally on every tool call from a Claude Code
  agent; the model has no path to inject `_meta.run_id`. The plan's
  `_meta.run_id` contract works for direct MCP consumers running their
  own agent loop (where the client owns `_meta`) but not for the plugin
  path where Claude Code's MCP client is in the middle. To group runs
  on the admin surface under the plugin path, `run_id` must move into
  tool arguments (server-side change, future work).
- Plugin's `agents/` dir contains exactly two static files
  (`nova-architect-interactive.md`, `nova-architect-autonomous.md`)
  throughout the run. No per-runId files materialized. The self-fetch
  bootstrap kept the frontmatter static and the body server-driven as
  designed.

## Open follow-ups

1. **Plugin tool-name prefix.** Claude Code scopes plugin-sourced MCP
   tools as `mcp__plugin_<pluginName>_<serverName>__<toolName>` per
   `utils/plugins/mcpPluginIntegration.ts:339-354` (`scopedName =
   'plugin:' + pluginName + ':' + name`). The plan used the unscoped
   `mcp__nova__*` form throughout, which only resolves for user-scope
   `claude mcp add` entries. The plugin's agents + skills were
   corrected to `mcp__plugin_nova_nova__*` under `fix(mcp): tool-name
   prefix uses plugin-scoped form` in the plugin repo; the design spec
   + Phase F plan still reference the old name and should be updated in
   a later pass.
2. **`run_id` propagation.** Move `run_id` from `_meta` to a tool
   argument on every mutation + read tool. Update
   `lib/mcp/runId.ts#resolveRunId` to pull from `args.run_id` first,
   fall back to `_meta.run_id` for direct-MCP-consumer compatibility,
   then fall back to `crypto.randomUUID()`. Update each tool schema to
   declare `run_id` and the plugin's agent files + skills to thread it
   through.
