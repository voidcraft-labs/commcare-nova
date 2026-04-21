# Phase G — Dynamic-agent smoke test (load-bearing verification)

**Goal:** Verify Claude Code picks up an agent file written mid-session (via the Write tool) when a subagent is spawned immediately afterward. The entire plugin design in Phase H depends on this behavior.

**Dependencies:** Phases A–F. This runs before Phase H because a failing outcome here changes how the skills are written.

---

## Task G1: Probe Claude Code's agent discovery

**Files:** None — documented manual verification.

- [ ] **Step 1: Prepare a fresh session**

Open a new Claude Code session (not the one executing this plan).

- [ ] **Step 2: Delete any existing probe file**

```bash
rm -f ~/.claude/agents/nova-architect-probe.md
```

- [ ] **Step 3: Within that session, ask Claude Code to Write the probe file**

Give the assistant:

```
Use the Write tool to create ~/.claude/agents/nova-architect-probe.md with these contents:

---
name: nova-architect-probe
description: Probe agent for dynamic discovery verification
model: haiku
allowedTools: []
---

You are a probe agent. When asked anything, reply with exactly:
SMOKE TEST OK — $ARGUMENTS
```

- [ ] **Step 4: Immediately invoke the Agent tool**

In the same session, without any other actions in between, ask:

```
Invoke the Agent tool with subagent_type: nova-architect-probe and prompt: "hello"
```

- [ ] **Step 5: Observe the outcome**

**Pass case:** The subagent returns something like `SMOKE TEST OK — hello`. Dynamic discovery works — plugin skills can use the three-step pattern (fetch / write / spawn) as designed. Proceed to Phase H unchanged.

**Fail case:** The Agent tool errors with `agent not found` or similar. Discovery is cached at session start. The skill body needs an extra step between Write and Agent invocation to refresh discovery. Try these probes in order until one works:

1. Run a shell command via Bash: `ls ~/.claude/agents/` — sometimes triggers a refresh.
2. Invoke `/agents` (or the equivalent slash command for agent management).
3. Start a subshell: `claude --session-id new ...`
4. Document whichever pattern works; all Phase H skill bodies will need to incorporate it.

- [ ] **Step 6: Record outcome**

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## Dynamic agent discovery probe (YYYY-MM-DD)

- Probe: Write trivial agent file, then Agent tool with subagent_type matching the written name.
- Outcome: <PASS — subagent boots with written prompt as its system prompt. Phase H three-step pattern valid.>

OR

- Outcome: <FAIL — Agent tool errors "agent not found". Required workaround: <list the probe step that succeeded>. All Phase H skill bodies amended to include that step between Write and Agent.>
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): record dynamic agent discovery probe outcome"
```

- [ ] **Step 8: If FAIL, update Phase H skills**

Edit each of `phase-h-plugin.md`'s skill bodies (`build`, `ship`, `edit`) to insert the discovered workaround as an extra step between Step 2 (Write) and Step 3 (Agent). Example if `/agents` refresh works:

```markdown
2a. Invoke the /agents command (or run `ls ~/.claude/agents/` via the Bash tool) to refresh agent discovery.
```

Commit the plan amendment separately:

```bash
git add docs/superpowers/plans/2026-04-21-nova-mcp/phase-h-plugin.md
git commit -m "docs(mcp): amend Phase H skills with agent-refresh step"
```

- [ ] **Step 9: Clean up the probe**

```bash
rm -f ~/.claude/agents/nova-architect-probe.md
```
