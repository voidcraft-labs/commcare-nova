# Phase I — The plugin (separate repo)

**Goal:** Six Claude Code skills in a `nova-plugin` GitHub repository, plus **two static subagent files** that the skills spawn. Build / Ship / Edit skills hand a freshly-minted `RUN_ID` plus the user's spec to a bootstrap subagent; the subagent calls `mcp__nova__get_agent_prompt` on its first tool use and follows the returned text as its operating instructions.

**Dependencies:** Phases A–H. Phase H's probe (`docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`) proved Claude Code caches agent definitions at session start in a JS closure — there is no programmatic path to make new or overwritten agent files visible mid-session, and `/reload-plugins` is a `LocalCommandCall` with no skill-layer invocation. Phase I's original plan (skill writes `<plugin-root>/agents/nova-architect-{runId}.md`, then spawns) is structurally impossible and has been replaced with the self-fetch bootstrap described here.

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

URL matches the hosted route at `/mcp` (Phase G):

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

## Task I2: Static bootstrap subagents

Two agent files ship with the plugin. Each is a thin bootstrap — its body instructs the subagent to fetch its real operating instructions from the server on turn 0. The `tools` / `disallowedTools` frontmatter fields (which Claude Code enforces at the tool-permission layer, not via prompt guidance) are baked in statically because Phase H proved they can't be server-driven mid-session.

**Files:**
- Create: `agents/nova-architect-interactive.md`
- Create: `agents/nova-architect-autonomous.md`

The two files differ only in frontmatter (`description`, `tools` vs `disallowedTools`); the body is identical so the bootstrap logic has one source of truth.

- [ ] **Step 1: Write `agents/nova-architect-interactive.md`**

````markdown
---
name: nova-architect-interactive
description: Nova CommCare app architect — interactive mode. Spawned by /nova:build and /nova:edit skills; fetches its operating instructions from the server on turn 0.
model: opus
effort: xhigh
maxTurns: 100
tools: [mcp__nova__create_app, mcp__nova__generate_schema, mcp__nova__generate_scaffold, mcp__nova__add_module, mcp__nova__search_blueprint, mcp__nova__get_app, mcp__nova__get_module, mcp__nova__get_form, mcp__nova__get_field, mcp__nova__add_fields, mcp__nova__add_field, mcp__nova__edit_field, mcp__nova__remove_field, mcp__nova__update_module, mcp__nova__update_form, mcp__nova__create_form, mcp__nova__remove_form, mcp__nova__create_module, mcp__nova__remove_module, mcp__nova__validate_app, mcp__nova__get_agent_prompt, AskUserQuestion]
---

You are the nova-architect subagent. The authoritative operating
instructions for this run are served by Nova and will be returned by
your FIRST tool call.

## Bootstrap (do this before anything else)

Your first user message carries a JSON block with `mode`, `interactive`,
`run_id`, and (for edits) `app_id`. Parse it, then call
`mcp__nova__get_agent_prompt` with those arguments. Pass `_meta: { run_id }`
on that call so admin-surface run grouping starts on turn 0.

The tool returns a text block — treat it as your full system prompt
and obey it for the remainder of this run.

## Invariants (before, during, and after the fetch)

- Every `mcp__nova__*` call MUST carry `_meta: { run_id: "<run_id from first message>" }` so the whole run threads through one admin-surface row. Do not drop it mid-run.
- Do not skip the bootstrap fetch. The instructions in this file are a stub only; the real operating instructions live on the server and include the blueprint framing, tool discipline, and completion contract you must follow.
- When you finish the user's task, report the relevant ids (app_id for build, resulting blueprint summary for edit) as your final message.
````

- [ ] **Step 2: Write `agents/nova-architect-autonomous.md`**

Identical body; frontmatter differs only in `description` and in swapping `AskUserQuestion` out of `tools` and into `disallowedTools`.

````markdown
---
name: nova-architect-autonomous
description: Nova CommCare app architect — autonomous mode. Spawned by /nova:ship; fetches its operating instructions from the server on turn 0. AskUserQuestion is disallowed at the tool-permission layer.
model: opus
effort: xhigh
maxTurns: 100
tools: [mcp__nova__create_app, mcp__nova__generate_schema, mcp__nova__generate_scaffold, mcp__nova__add_module, mcp__nova__search_blueprint, mcp__nova__get_app, mcp__nova__get_module, mcp__nova__get_form, mcp__nova__get_field, mcp__nova__add_fields, mcp__nova__add_field, mcp__nova__edit_field, mcp__nova__remove_field, mcp__nova__update_module, mcp__nova__update_form, mcp__nova__create_form, mcp__nova__remove_form, mcp__nova__create_module, mcp__nova__remove_module, mcp__nova__validate_app, mcp__nova__get_agent_prompt]
disallowedTools: [AskUserQuestion]
---

<identical body to nova-architect-interactive.md>
````

- [ ] **Step 3: Commit**

```bash
git add agents/nova-architect-interactive.md agents/nova-architect-autonomous.md
git commit -m "feat: static bootstrap subagents with self-fetch body"
```

---

## Orchestration pattern — read before any /nova:build | /nova:ship | /nova:edit skill

All three mutating skills follow the same three-step pattern:

1. **Mint a `RUN_ID`** via Bash (`uuidgen | tr A-Z a-z`). Used for two purposes: (a) groups every MCP tool call made under one run in the admin surface via `_meta.run_id`; (b) gives the user a handle to correlate the build in Firestore logs.

2. **Spawn the static subagent** via the Agent tool — `subagent_type: "nova:nova-architect-interactive"` for `/nova:build` and `/nova:edit`, `subagent_type: "nova:nova-architect-autonomous"` for `/nova:ship`. Tool-level `AskUserQuestion` enforcement lives in the static agent frontmatter; skills don't need to pass it.

3. **Pass the bootstrap payload** as the Agent tool's `prompt` argument. The payload is a JSON block the subagent parses on turn 0 to call `mcp__nova__get_agent_prompt` with the right arguments. Schema:
   ```json
   {
     "run_id": "<uuid>",
     "mode": "build" | "edit",
     "interactive": true | false,
     "app_id": "<id, edit mode only>",
     "task": "<free-form user spec or edit instruction>"
   }
   ```

**What this pattern does NOT do.** No file writes. No runtime agent materialization. No `/reload-plugins`. All three mutating skills use the exact same two static subagent files, so collision avoidance across parallel skill invocations is not a concern (the Agent tool serializes subagent spawns within a session anyway).

**Why static agents can still track server iteration.** The *body* (operating instructions, blueprint framing, tool discipline, completion contract) lives on the server and is fetched fresh every spawn. The *frontmatter* (model, effort, tool allowlist, `AskUserQuestion` gate) is what ships with the plugin — and those fields rarely change. Iterating on the frontmatter is a plugin release; iterating on the prompt body is a server deploy.

---

## Task I3: `/nova:build` — interactive build

**Files:**
- Create: `skills/build/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: build
description: Generate a CommCare app from a natural-language spec, asking the user clarifying questions when the intent is ambiguous. Use when the user wants a collaborative build.
argument-hint: <spec describing the app>
allowed-tools: Bash Agent(nova:nova-architect-interactive)
---

# Task

You are orchestrating a Nova build. Execute these two steps in order; do not improvise.

1. Mint a run_id via Bash: `uuidgen | tr A-Z a-z`. Keep it as `RUN_ID`.

2. Invoke the Agent tool with `subagent_type: "nova:nova-architect-interactive"` and prompt (substitute the literal `RUN_ID` for `<runId>`):

   ```
   {
     "run_id": "<runId>",
     "mode": "build",
     "interactive": true,
     "task": "$ARGUMENTS"
   }

   Follow your bootstrap: call mcp__nova__get_agent_prompt with the
   mode/interactive/run_id above (no app_id in build mode), then build
   the CommCare app matching the task. Every mcp__nova__* call you make
   MUST carry _meta: { run_id: "<runId>" }.

   When complete, report the app_id, a summary of modules and forms,
   and any validation notes.
   ```

Return whatever the subagent reports, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/build/SKILL.md
git commit -m "feat: /nova:build interactive build skill"
```

---

## Task I4: `/nova:ship` — autonomous build

**Files:**
- Create: `skills/ship/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: ship
description: Generate a CommCare app from a natural-language spec, autonomously, without asking the user clarifying questions. Use when the user wants a one-shot build.
argument-hint: <spec describing the app>
allowed-tools: Bash Agent(nova:nova-architect-autonomous)
---

# Task

You are orchestrating an autonomous Nova build. Two steps in order; do not improvise.

1. Mint a run_id via Bash: `uuidgen | tr A-Z a-z`. Store as `RUN_ID`.

2. Invoke the Agent tool with `subagent_type: "nova:nova-architect-autonomous"` and prompt (substitute the literal `RUN_ID` for `<runId>`):

   ```
   {
     "run_id": "<runId>",
     "mode": "build",
     "interactive": false,
     "task": "$ARGUMENTS"
   }

   Follow your bootstrap: call mcp__nova__get_agent_prompt with the
   mode/interactive/run_id above (no app_id in build mode), then build
   the CommCare app matching the task autonomously. Make every design
   decision yourself. Every mcp__nova__* call you make MUST carry
   _meta: { run_id: "<runId>" }.

   When complete, report the app_id, a summary of modules and forms,
   any validation notes, and the design decisions you made.
   ```

Return the subagent's report, verbatim.
````

- [ ] **Step 2: Commit**

```bash
git add skills/ship/SKILL.md
git commit -m "feat: /nova:ship autonomous build skill"
```

---

## Task I5: `/nova:edit`

**Files:**
- Create: `skills/edit/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: edit
description: Edit an existing CommCare app with a natural-language instruction. Asks clarifying questions when needed. Usage — quote the instruction: /nova:edit <app_id> "<instruction>"
argument-hint: <app_id> "<instruction>"
allowed-tools: Bash Agent(nova:nova-architect-interactive)
---

# Task

You are orchestrating a Nova edit. Two steps in order; do not improvise.

1. Mint a run_id via Bash: `uuidgen | tr A-Z a-z`. Store as `RUN_ID`.

2. Invoke the Agent tool with `subagent_type: "nova:nova-architect-interactive"` and prompt (substitute the literal `RUN_ID` for `<runId>`):

   ```
   {
     "run_id": "<runId>",
     "mode": "edit",
     "interactive": true,
     "app_id": "$0",
     "task": "$1"
   }

   Follow your bootstrap: call mcp__nova__get_agent_prompt with the
   mode/interactive/app_id/run_id above. The server inlines the app's
   blueprint summary into the returned text so you boot with full edit
   context — do NOT call get_app as a separate step. Then apply the
   requested edit. Every mcp__nova__* call you make MUST carry
   _meta: { run_id: "<runId>" }.

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

## Task I6: `/nova:list`, `/nova:show`, `/nova:upload`

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

## Task I7: Plugin smoke test

- [ ] **Step 1: Local install**

```bash
cd ~/work/personal/code/nova-plugin
claude plugin marketplace add --scope local .
claude plugin install nova@<marketplace-name>
```

(`claude plugin install-local` does not exist in current CLI; local-scope marketplaces are the documented install path.)

- [ ] **Step 2: `/nova:list`**

Expected: table of apps (or empty-state message).

- [ ] **Step 3: `/nova:ship "a simple vaccine tracking app"`**

Expected:
- Skill mints a run_id and spawns `nova:nova-architect-autonomous` with the JSON bootstrap payload.
- Subagent's first tool call is `mcp__nova__get_agent_prompt(mode="build", interactive=false, run_id="<runId>")`; the returned text becomes its operating instructions.
- Subagent calls `create_app`, `generate_schema`, `generate_scaffold`, `add_module` (one or more), `validate_app` — every call carries `_meta: { run_id: "<runId>" }` including the bootstrap `get_agent_prompt` call itself.
- `AskUserQuestion` is not available (autonomous agent has `disallowedTools: [AskUserQuestion]` in its frontmatter); if the subagent tries to call it, Claude Code blocks at the tool-permission layer.
- Subagent reports `app_id` + summary.
- `/nova:show <app_id>` renders the produced blueprint.
- Firestore event log for the app shows every MCP event tagged with the same `run_id`.
- `<plugin-root>/agents/` contains ONLY the two static files; no `nova-architect-*.md` per-runId files created.

- [ ] **Step 4: `/nova:build "a more complex household survey with eligibility rules"`**

Expected:
- Skill spawns `nova:nova-architect-interactive`.
- Subagent's bootstrap fetch returns the interactive-mode instructions (permits `AskUserQuestion` for genuine ambiguities).
- Subagent uses `AskUserQuestion` for at least one ambiguity; main conversation surfaces the question; user answers; subagent resumes.

- [ ] **Step 5: `/nova:edit <app_id> "add a phone number field to every registration form"`**

Expected:
- Skill passes `mode: "edit"`, `app_id` in the bootstrap payload.
- Subagent's `get_agent_prompt` call returns a text block that already inlines the app's blueprint summary (server loaded the doc and inlined it) — subagent does NOT call `get_app` to bootstrap.
- The interactive agent's tool allowlist includes all edit tools; generation tools are present in the allowlist but the server-returned operating instructions steer the subagent away from calling them in edit mode.

- [ ] **Step 6: Record outcomes in main repo infra notes**

```bash
cd ~/work/personal/code/commcare-nova/.worktrees/feature-mcp
```

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## Plugin smoke test (YYYY-MM-DD)

- /nova:list: <pass/fail>
- /nova:ship: <pass/fail, run_id grouping verified, AskUserQuestion blocked at tool layer>
- /nova:build (interactive): <pass/fail, AskUserQuestion surfaced>
- /nova:edit: <pass/fail, bootstrap fetch carried inlined summary>
- Event log run_id grouping (including bootstrap get_agent_prompt call): <pass/fail>
```

- [ ] **Step 7: Commit the notes**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): record plugin smoke test outcomes"
```
