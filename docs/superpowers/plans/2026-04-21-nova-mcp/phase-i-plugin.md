# Phase I — The plugin (separate repo)

**Goal:** Six Claude Code skills in a `nova-plugin` GitHub repository. Each skill is a markdown file with YAML frontmatter; Claude Code loads them at install time. Build / Ship / Edit skills orchestrate the four-step mint-run-id → fetch → write → spawn dance against the hosted MCP. Per-runId agent filenames prevent collision between parallel skill invocations and allow dynamic per-run frontmatter.

**Dependencies:** Phases A–H. Phase H may have amended skill bodies to add a discovery-refresh step between Write and Agent — apply that amendment here if it landed.

**Where this work lives:** Separate repo at `github.com/dimagi/nova-plugin`, not inside `commcare-nova`.

---

## Task I1: Plugin scaffold

**Files (in new `nova-plugin` repo):**
- Create: `.claude-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `README.md`
- Create: `.gitignore`

- [ ] **Step 1: Create the repo**

```bash
mkdir -p ~/work/personal/code/nova-plugin
cd ~/work/personal/code/nova-plugin
git init
```

- [ ] **Step 2: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "nova",
  "version": "1.0.0",
  "description": "Build, edit, compile, and deploy CommCare apps from Claude Code",
  "author": { "name": "Dimagi", "email": "support@dimagi.com" },
  "homepage": "https://docs.commcare.app/mcp",
  "repository": "https://github.com/dimagi/nova-plugin",
  "license": "Apache-2.0"
}
```

- [ ] **Step 3: Write `.mcp.json`**

URL must match the hosted route — `/api/mcp` per `mcp-handler`'s `[transport]` convention (Phase G):

```json
{
  "mcpServers": {
    "nova": {
      "type": "http",
      "url": "https://mcp.commcare.app/api/mcp"
    }
  }
}
```

- [ ] **Step 4: Write `README.md`**

```markdown
# Nova for Claude Code

Build, edit, compile, and deploy CommCare apps from Claude Code.

## Install

    /plugin marketplace add dimagi/nova-marketplace
    /plugin install nova@nova-marketplace

## Authenticate

First use of any `/nova:*` skill opens your browser to sign in at commcare.app.
Tokens are stored in Claude Code's credential store; revoke via `/mcp` → nova → Clear authentication.

## Skills

- `/nova:build <spec>` — interactive build; subagent asks clarifying questions
- `/nova:ship <spec>` — autonomous build; subagent commits to defaults
- `/nova:edit <app_id> "<instruction>"` — edit an existing app
- `/nova:list` — list your apps
- `/nova:show <app_id>` — blueprint summary
- `/nova:upload <app_id> <domain> [app_name]` — deploy to CommCare HQ
```

- [ ] **Step 5: Write `.gitignore`**

```
.DS_Store
node_modules/
```

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: initial plugin scaffold"
```

---

## Orchestration pattern — read before any /nova:build | /nova:ship | /nova:edit skill

All three mutating skills follow the same four-step pattern:

1. **Mint a run_id** — `run_id = crypto.randomUUID()`. Used for two purposes: (a) groups every MCP tool call this subagent makes under one run in the admin surface; (b) keys the agent filename so parallel skill invocations can't clobber each other.

2. **Fetch** — call `mcp__nova__get_agent_prompt(mode, interactive)`. Parse the returned JSON `{ frontmatter, system_prompt }`.

3. **Write** — Write `~/.claude/agents/nova-architect-{run_id}.md` with the fetched frontmatter as YAML + system_prompt as markdown body. Each invocation gets its own file.

4. **Spawn** — invoke the Agent tool with `subagent_type: nova-architect-{run_id}` and a task prompt that (a) instructs the subagent to pass `_meta: { run_id: "<run_id>" }` on every MCP tool call so the server groups the build coherently, and (b) carries the user's spec / app_id / instruction.

Filename and subagent_type match because Claude Code derives the subagent type from the agent file's frontmatter `name` field; each per-runId agent file declares `name: nova-architect-{run_id}` (the server renders the frontmatter accordingly when it sees `_meta.run_id` on the get_agent_prompt call — skill passes the run_id through).

Actually — simpler — the skill body overrides the `name` field in the written YAML to `nova-architect-{run_id}` regardless of what the server returned. Phase F's `get_agent_prompt` tool returns `name: "nova-architect"` as a default; the skill body overrides before writing.

**No cleanup step in v1.** Files accumulate in `~/.claude/agents/`; if the directory gets busy, users can `rm ~/.claude/agents/nova-architect-*.md`. A scheduled `/cleanup` skill is additive later.

---

## Task I2: `/nova:build` — interactive build

**Files:**
- Create: `skills/build/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: build
description: Generate a CommCare app from a natural-language spec, asking the user clarifying questions when the intent is ambiguous. Use when the user wants a collaborative build.
argument-hint: <spec describing the app>
allowed-tools: mcp__nova__get_agent_prompt Write Agent(nova-architect-*)
---

# Task

You are orchestrating a Nova build. Execute these four steps in order; do not improvise.

1. Mint a run_id by generating a UUID v4 (you can ask for one via the Bash tool: `uuidgen | tr A-Z a-z`). Keep it in a variable as `RUN_ID`.

2. Call `mcp__nova__get_agent_prompt` with `mode: "build"` and `interactive: true`. Parse the JSON from the returned text content.

3. Override the `name` field in the returned frontmatter to `nova-architect-${RUN_ID}`. Write `~/.claude/agents/nova-architect-${RUN_ID}.md` with the modified frontmatter as YAML and the system_prompt as the markdown body. YAML serialization: each top-level key on its own line; arrays as YAML sequences; omit keys the frontmatter doesn't carry.

4. Invoke the Agent tool with `subagent_type: nova-architect-${RUN_ID}` and prompt:

   ```
   Build a CommCare app matching this spec: $ARGUMENTS.

   IMPORTANT: On every MCP tool call you make that accepts a run context, pass `_meta: { run_id: "${RUN_ID}" }` so the server groups this build as one coherent run in the admin surface.

   When complete, report the app_id, a summary of modules and forms, and any validation notes.
   ```

Return whatever the subagent reports, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/build/SKILL.md
git commit -m "feat: /nova:build interactive build skill"
```

---

## Task I3: `/nova:ship` — autonomous build

**Files:**
- Create: `skills/ship/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: ship
description: Generate a CommCare app from a natural-language spec, autonomously, without asking the user clarifying questions. Use when the user wants a one-shot build.
argument-hint: <spec describing the app>
allowed-tools: mcp__nova__get_agent_prompt Write Agent(nova-architect-*)
---

# Task

You are orchestrating an autonomous Nova build. Four steps in order; do not improvise.

1. Mint a run_id (UUID v4).

2. Call `mcp__nova__get_agent_prompt` with `mode: "build"` and `interactive: false`. Parse the JSON. The autonomous-mode frontmatter carries `disallowedTools: [AskUserQuestion]` — preserve it in the written file.

3. Override the `name` field to `nova-architect-${RUN_ID}`. Write `~/.claude/agents/nova-architect-${RUN_ID}.md` with the modified frontmatter as YAML and system_prompt as markdown body.

4. Invoke the Agent tool with `subagent_type: nova-architect-${RUN_ID}` and prompt:

   ```
   Build a CommCare app matching this spec, autonomously. Make every design decision yourself.

   Spec: $ARGUMENTS.

   IMPORTANT: On every MCP tool call that accepts a run context, pass `_meta: { run_id: "${RUN_ID}" }`.

   When complete, report the app_id, a summary of modules and forms, any validation notes, and the design decisions you made.
   ```

Return the subagent's report, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/ship/SKILL.md
git commit -m "feat: /nova:ship autonomous build skill"
```

---

## Task I4: `/nova:edit`

**Files:**
- Create: `skills/edit/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: edit
description: Edit an existing CommCare app with a natural-language instruction. Asks clarifying questions when needed. Usage — quote the instruction: /nova:edit <app_id> "<instruction>"
argument-hint: <app_id> "<instruction>"
allowed-tools: mcp__nova__get_agent_prompt Write Agent(nova-architect-*)
---

# Task

You are orchestrating a Nova edit. Four steps in order; do not improvise.

1. Mint a run_id (UUID v4).

2. Call `mcp__nova__get_agent_prompt` with `mode: "edit"` and `interactive: true`. Parse the JSON.

3. Override the `name` field to `nova-architect-${RUN_ID}`. Write `~/.claude/agents/nova-architect-${RUN_ID}.md` with the modified frontmatter as YAML and system_prompt as markdown body.

4. Invoke the Agent tool with `subagent_type: nova-architect-${RUN_ID}` and prompt:

   ```
   Edit the existing CommCare app. App ID: $0. Instruction: $1.

   Before making changes, call `nova.get_app` with `app_id: "$0"` to read the current blueprint summary.

   IMPORTANT: On every MCP tool call that accepts a run context, pass `_meta: { run_id: "${RUN_ID}" }`.

   When complete, report the modified blueprint summary.
   ```

Return the subagent's report, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/edit/SKILL.md
git commit -m "feat: /nova:edit skill"
```

---

## Task I5: `/nova:list`, `/nova:show`, `/nova:upload`

Non-mutating skills; no subagent spawn. They call the respective MCP tool directly from the main conversation and render the result.

**Files:**
- Create: `skills/list/SKILL.md`
- Create: `skills/show/SKILL.md`
- Create: `skills/upload/SKILL.md`

- [ ] **Step 1: `skills/list/SKILL.md`**

```markdown
---
name: list
description: List your Nova apps.
---

Call `mcp__nova__list_apps`. The tool returns JSON `{ apps: [...] }` inside a text content block. Parse it and format as a markdown table: ID, Name, Status, Last Updated.
```

- [ ] **Step 2: `skills/show/SKILL.md`**

```markdown
---
name: show
description: Show the blueprint summary of a Nova app.
argument-hint: <app_id>
---

Call `mcp__nova__get_app` with `app_id: "$ARGUMENTS"`. Present the returned markdown summary verbatim.
```

- [ ] **Step 3: `skills/upload/SKILL.md`**

```markdown
---
name: upload
description: Upload a Nova app to CommCare HQ.
argument-hint: <app_id> <domain> [app_name]
---

Call `mcp__nova__upload_app_to_hq` with:
- `app_id: "$0"`
- `domain: "$1"`
- `app_name: "$2"` (omit the field entirely if $2 is empty)

Report the resulting `hq_app_id` and `url` from the returned JSON.
```

- [ ] **Step 4: Commit**

```bash
git add skills/list/SKILL.md skills/show/SKILL.md skills/upload/SKILL.md
git commit -m "feat: /nova:list, /nova:show, /nova:upload skills"
```

---

## Task I6: Plugin smoke test

- [ ] **Step 1: Local install**

```bash
cd ~/work/personal/code/nova-plugin
claude plugin install-local .
```

- [ ] **Step 2: `/nova:list`**

Expected: table of apps (or empty-state message).

- [ ] **Step 3: `/nova:ship "a simple vaccine tracking app"`**

Expected:
- Skill mints a run_id + fetches autonomous-mode agent prompt.
- Skill writes `~/.claude/agents/nova-architect-<runId>.md`; confirm it contains `disallowedTools: [AskUserQuestion]`.
- Skill spawns the subagent using `subagent_type: nova-architect-<runId>`.
- Subagent calls `create_app`, `generate_schema`, `generate_scaffold`, `add_module` (one or more), `validate_app` — every call carries `_meta: { run_id: "<runId>" }`.
- Subagent reports `app_id` + summary.
- `/nova:show <app_id>` renders the produced blueprint.
- Firestore event log for the app shows every MCP event tagged with the same `run_id`.

- [ ] **Step 4: `/nova:build "a more complex household survey with eligibility rules"`**

Expected: subagent uses `AskUserQuestion` for at least one genuine ambiguity; main conversation surfaces the question; user answers; subagent resumes.

- [ ] **Step 5: `/nova:edit <app_id> "add a phone number field to every registration form"`**

Expected: edit-mode frontmatter omits generation tools; subagent only calls field/form mutation tools; calls `nova.get_app` at the start to read the current blueprint.

- [ ] **Step 6: Record outcomes in main repo infra notes**

```bash
cd ~/work/personal/code/commcare-nova/.worktrees/feature-mcp
```

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## Plugin smoke test (YYYY-MM-DD)

- /nova:list: <pass/fail>
- /nova:ship: <pass/fail, run_id grouping verified>
- /nova:build (interactive): <pass/fail>
- /nova:edit: <pass/fail>
- Event log run_id grouping: <pass/fail>
```

- [ ] **Step 7: Commit the notes**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): record plugin smoke test outcomes"
```
