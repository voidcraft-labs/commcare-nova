# Phase H — The plugin (separate repo)

**Goal:** Six Claude Code skills in a `nova-plugin` GitHub repository. Each skill is a markdown file with YAML frontmatter; Claude Code loads them at install time. Build/Ship/Edit skills orchestrate the three-step fetch → write → spawn dance against the hosted MCP.

**Dependencies:** Phases A–G. Phase G may have amended skill bodies to add a discovery-refresh step between Write and Agent — apply that amendment here if it landed.

**Where this work lives:** Separate repo at `github.com/dimagi/nova-plugin`, not inside `commcare-nova`. Create it fresh.

---

## Task H1: Plugin scaffold

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

```json
{
  "mcpServers": {
    "nova": {
      "type": "http",
      "url": "https://mcp.commcare.app/mcp"
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

## Task H2: `/nova:build` — interactive build

**Files:**
- Create: `skills/build/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: build
description: Generate a CommCare app from a natural-language spec, asking the user clarifying questions when the intent is ambiguous. Use when the user wants a collaborative build.
argument-hint: <spec describing the app>
allowed-tools: mcp__nova__get_agent_prompt Write Agent(nova-architect)
---

# Task

You are orchestrating a Nova build. Execute these three steps in order; do not improvise:

1. Call `mcp__nova__get_agent_prompt` with `mode: "build"` and `interactive: true`. The tool returns `{ frontmatter, system_prompt }` as a JSON string inside a single text content part. Parse the JSON.

2. Write `~/.claude/agents/nova-architect.md` using the Write tool. The file contents are:
   ```
   ---
   <YAML serialization of `frontmatter`>
   ---

   <`system_prompt` markdown>
   ```

   Serialize the frontmatter as standard YAML: each top-level key on its own line, arrays as YAML sequences. Omit keys that the parsed frontmatter does not include (do not emit null).

3. Invoke the Agent tool with `subagent_type: nova-architect` and the prompt:

   ```
   Build a CommCare app matching this spec: $ARGUMENTS. When complete, report the app_id, a summary of modules and forms, and any validation notes.
   ```

Return whatever the subagent reports, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/build/SKILL.md
git commit -m "feat: /nova:build interactive build skill"
```

---

## Task H3: `/nova:ship` — autonomous build

**Files:**
- Create: `skills/ship/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: ship
description: Generate a CommCare app from a natural-language spec, autonomously, without asking the user clarifying questions. Use when the user wants a one-shot build.
argument-hint: <spec describing the app>
allowed-tools: mcp__nova__get_agent_prompt Write Agent(nova-architect)
---

# Task

You are orchestrating an autonomous Nova build. Execute these three steps in order; do not improvise:

1. Call `mcp__nova__get_agent_prompt` with `mode: "build"` and `interactive: false`. Parse the JSON in the returned text content. The autonomous-mode frontmatter carries `disallowedTools: [AskUserQuestion]` — preserve it when serializing.

2. Write `~/.claude/agents/nova-architect.md` using the Write tool, serializing `frontmatter` as YAML and `system_prompt` as the markdown body.

3. Invoke the Agent tool with `subagent_type: nova-architect` and the prompt:

   ```
   Build a CommCare app matching this spec, autonomously. Make every design decision yourself. Spec: $ARGUMENTS. When complete, report the app_id, a summary of modules and forms, any validation notes, and the design decisions you made.
   ```

Return whatever the subagent reports, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/ship/SKILL.md
git commit -m "feat: /nova:ship autonomous build skill"
```

---

## Task H4: `/nova:edit`

**Files:**
- Create: `skills/edit/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: edit
description: Edit an existing CommCare app with a natural-language instruction. Asks clarifying questions when needed. Usage — quote the instruction: /nova:edit <app_id> "<instruction>"
argument-hint: <app_id> "<instruction>"
allowed-tools: mcp__nova__get_agent_prompt Write Agent(nova-architect)
---

# Task

You are orchestrating a Nova edit. Execute these three steps in order; do not improvise:

1. Call `mcp__nova__get_agent_prompt` with `mode: "edit"` and `interactive: true`. Parse the JSON.

2. Write `~/.claude/agents/nova-architect.md` using the Write tool with the returned frontmatter as YAML and system prompt as markdown body.

3. Invoke the Agent tool with `subagent_type: nova-architect` and the prompt:

   ```
   Edit the existing CommCare app. App ID: $0. Instruction: $1. Before making changes, call `nova.get_app` with app_id=$0 to read the current blueprint summary. When complete, report the modified blueprint summary.
   ```

Return whatever the subagent reports, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/edit/SKILL.md
git commit -m "feat: /nova:edit skill"
```

---

## Task H5: `/nova:list`, `/nova:show`, `/nova:upload`

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

Call `mcp__nova__list_apps`. The tool returns JSON `{ apps: [...] }` inside a text content block. Parse it and format the result as a markdown table with columns: ID, Name, Status, Last Updated. Do not do anything else — this skill is a thin display wrapper.
```

- [ ] **Step 2: `skills/show/SKILL.md`**

```markdown
---
name: show
description: Show the blueprint summary of a Nova app.
argument-hint: <app_id>
---

Call `mcp__nova__get_app` with `app_id: "$ARGUMENTS"`. The tool returns the blueprint summary as markdown text. Present it verbatim to the user.
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

Report the resulting `hq_app_id` and `url` from the returned JSON so the user can click through to CommCare HQ.
```

- [ ] **Step 4: Commit**

```bash
git add skills/list/SKILL.md skills/show/SKILL.md skills/upload/SKILL.md
git commit -m "feat: /nova:list, /nova:show, /nova:upload skills"
```

---

## Task H6: Plugin smoke test

- [ ] **Step 1: Local install**

From the plugin repo root:

```bash
cd ~/work/personal/code/nova-plugin
claude plugin install-local .
```

- [ ] **Step 2: `/nova:list`**

Expected: table of apps (or empty-state message).

- [ ] **Step 3: `/nova:ship "a simple vaccine tracking app"`**

Expected:
- Skill fetches the autonomous-mode agent prompt.
- Skill writes `~/.claude/agents/nova-architect.md`; confirm it contains `disallowedTools: [AskUserQuestion]`.
- Skill spawns the subagent.
- Subagent calls `create_app`, `generate_schema`, `generate_scaffold`, `add_module` (one or more), `validate_app`.
- Subagent reports `app_id` + summary.
- `/nova:show <app_id>` renders the produced blueprint.

- [ ] **Step 4: `/nova:build "a more complex household survey with eligibility rules"`**

Expected: subagent uses `AskUserQuestion` at least once; main conversation renders the question, user answers, subagent resumes.

- [ ] **Step 5: `/nova:edit <app_id> "add a phone number field to every registration form"`**

Expected: edit-mode frontmatter omits generation tools; subagent only calls field/form mutation tools.

- [ ] **Step 6: Record outcomes in main repo infra notes**

In the main `commcare-nova` worktree:

```bash
cd ~/work/personal/code/commcare-nova/.worktrees/feature-mcp
```

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## Plugin smoke test (YYYY-MM-DD)

- /nova:list: <pass/fail>
- /nova:ship: <pass/fail, notes>
- /nova:build (interactive): <pass/fail, notes>
- /nova:edit: <pass/fail, notes>
```

- [ ] **Step 7: Commit the notes**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): record plugin smoke test outcomes"
```
