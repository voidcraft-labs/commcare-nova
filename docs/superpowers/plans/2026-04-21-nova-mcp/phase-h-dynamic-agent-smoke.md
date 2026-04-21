# Phase H — Dynamic-agent smoke test (load-bearing verification)

**Goal:** Verify Claude Code discovers agent files written INTO A PLUGIN'S `agents/` directory mid-session and routes `Agent(subagent_type: "<plugin>:<name>")` to them correctly. The plugin design in Phase I depends on this behavior — without it, the skills fall back to writing `~/.claude/agents/` per-runId (pollutes user namespace).

**Dependencies:** Phases A–G. Runs before Phase I because a failing outcome changes how the skills are written.

---

## Task H1: Probe plugin-dir dynamic agent discovery

**Files:** None — documented manual verification. Requires a real (minimal) installed plugin to test against, since we're verifying plugin-scoped behavior, not user-dir behavior.

- [ ] **Step 1: Prepare a throwaway probe plugin**

In a scratch directory:

```bash
mkdir -p ~/scratch/nova-probe/.claude-plugin ~/scratch/nova-probe/agents ~/scratch/nova-probe/skills/probe
cat > ~/scratch/nova-probe/.claude-plugin/plugin.json <<'EOF'
{ "name": "nova-probe", "version": "0.0.0", "description": "Dynamic discovery probe" }
EOF
cat > ~/scratch/nova-probe/skills/probe/SKILL.md <<'EOF'
---
name: probe
description: Probe dynamic agent discovery
allowed-tools: Bash Write Agent(nova-probe:probe-agent-*)
---

1. Generate `RUN_ID=$(uuidgen | tr A-Z a-z)` via Bash.
2. Resolve plugin root: `PLUGIN_ROOT="$(cd "$CLAUDE_SKILL_DIR/../.." && pwd)"`.
3. Write `${PLUGIN_ROOT}/agents/probe-agent-${RUN_ID}.md` with this content:

   ```
   ---
   name: probe-agent-${RUN_ID}
   description: Dynamic probe
   model: haiku
   allowedTools: []
   ---

   You are a probe agent. Reply with exactly:
   SMOKE TEST OK — $ARGUMENTS
   ```

4. Invoke Agent with `subagent_type: "nova-probe:probe-agent-${RUN_ID}"` and prompt `"hello"`.

Return whatever the subagent reports.
EOF
```

Install locally:

```bash
claude plugin install-local ~/scratch/nova-probe
```

- [ ] **Step 2: Run the probe**

In a fresh Claude Code session:

```
/nova-probe:probe
```

- [ ] **Step 3: Observe the outcome**

**Pass case:** Subagent returns `SMOKE TEST OK — hello`. Plugin-dir dynamic discovery works; namespacing via `<plugin>:<agent-name>` addresses the freshly-written file correctly. Phase I skills land as specified — no amendment needed.

**Fail case A (agent not found):** Claude Code caches plugin agent listings at plugin-load time. Mid-session writes aren't picked up without a reload. Try these workarounds in order:

1. `/reload-plugins` after Write, before Agent.
2. Restart the session entirely (nuclear — breaks the whole skill pattern).

If `/reload-plugins` works, Phase I skills add that invocation as a new step between Write and Agent.

**Fail case B (wrong namespace / different addressability):** Subagent_type resolution differs from expected. Try variants:
- Bare name (no namespace): `subagent_type: "probe-agent-${RUN_ID}"`
- Project-relative path
- Match the skill-namespace format used for `/nova-probe:probe` (observed from the /mcp listing on the installed plugin)

Document whichever form resolves and update Phase I's skill bodies to match.

**Fail case C (total non-discoverability):** If NO form of addressability works for dynamically-written plugin agents, fall back to the previous pattern: write to `~/.claude/agents/nova-architect-${RUN_ID}.md` with `subagent_type: "nova-architect-${RUN_ID}"`. This pollutes the user's agent namespace but is known-viable (see first research agent findings: `~/.claude/agents/` has higher precedence and uncached discovery is the default assumption). Update Phase I skills accordingly and note the pollution trade-off in the infra doc.

- [ ] **Step 4: Record outcome**

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## Dynamic agent discovery probe (YYYY-MM-DD)

Probe: plugin skill mints runId, resolves plugin root via $CLAUDE_SKILL_DIR/../.., writes probe-agent-<runId>.md to <plugin-root>/agents/, invokes Agent(subagent_type: nova-probe:probe-agent-<runId>).

Outcome: <one of the cases above — fill in>.

Impact on Phase I skills: <none / add /reload-plugins step / fall back to ~/.claude/agents/ writes>.
```

- [ ] **Step 5: Commit**

```bash
cd ~/work/personal/code/commcare-nova/.worktrees/feature-mcp
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): record dynamic agent discovery probe outcome"
```

- [ ] **Step 6: Apply any required Phase I amendments**

If Fail case A or C fired, edit `docs/superpowers/plans/2026-04-21-nova-mcp/phase-i-plugin.md` to incorporate the workaround. Commit separately:

```bash
git add docs/superpowers/plans/2026-04-21-nova-mcp/phase-i-plugin.md
git commit -m "docs(mcp): amend Phase I skills per dynamic-discovery probe outcome"
```

- [ ] **Step 7: Clean up probe**

```bash
claude plugin uninstall nova-probe
rm -rf ~/scratch/nova-probe
```
