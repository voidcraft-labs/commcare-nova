# Phase K — Final end-to-end smoke

**Goal:** Build, edit, compile, upload a non-trivial app via the plugin. Verify the web UI continues to work unchanged. Verify per-surface event tagging and run_id grouping.

**Dependencies:** Phases A–J complete; plugin published.

---

## Task K1: Full flow from published marketplace

**Files:** None.

- [ ] **Step 1: Fresh install**

In a new Claude Code session:

```
/plugin marketplace add dimagi/nova-marketplace
/plugin install nova@nova-marketplace
```

- [ ] **Step 2: Build**

```
/nova:build "a household registration app that captures head-of-household name, phone number, number of children under 5, and nutritional status per child"
```

Expected:
- Subagent uses `AskUserQuestion` for 1–3 genuine ambiguities (e.g., "should children be a child case type or per-child fields on the household?").
- Subagent completes the build.
- Final report includes `app_id` + module/form/field summary.

- [ ] **Step 3: Edit**

```
/nova:edit <app_id> "add an ethnicity field to household registration with these options: Black, White, Hispanic, Asian, Other"
```

Expected: field added; blueprint summary updated with the new field.

- [ ] **Step 4: Upload**

```
/nova:upload <app_id> <your-hq-domain> "Nova Smoke Test"
```

Expected: `hq_app_id` + clickable URL returned. Visit the URL and verify the app exists in CommCare HQ.

- [ ] **Step 5: Web UI regression check**

Open `https://commcare.app` in a browser, log in:
- The existing web chat at `/api/chat` still works exactly as before.
- The smoke-test app from Step 2 appears in the web app list.
- Editing the app in the web UI then refreshing the plugin's `/nova:show <app_id>` reflects the change (and vice versa).

- [ ] **Step 6: Verify per-surface event tagging**

In the Firestore console, open the event log for the smoke-test app at `apps/<app_id>/events/`. Confirm:
- Events from Steps 2 + 3 (built + edited via plugin) carry `source: "mcp"`.
- Events from Step 5 (edited via web UI) carry `source: "chat"`.

If any event lacks a `source` field, it's either (a) a missed call site from Phase C Task C1 — grep `new LogWriter(` and fix the construction — or (b) a historical event the Phase C Task C1 migration missed. Run the migration dry-run again to confirm no backlog remains; if any does, investigate before shipping.

- [ ] **Step 7: Record outcome**

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## Final end-to-end smoke (YYYY-MM-DD)

- Fresh install from marketplace: <pass/fail>
- /nova:build w/ AskUserQuestion: <pass/fail>
- /nova:edit: <pass/fail>
- /nova:upload to HQ: <pass/fail, hq_app_id>
- Web UI regression: <pass/fail>
- Per-surface event tagging (chat vs mcp): <pass/fail>
- Run_id grouping across multi-tool plugin build: <pass/fail>
```

- [ ] **Step 8: Final commit**

```bash
cd ~/work/personal/code/commcare-nova/.worktrees/feature-mcp
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit --allow-empty -m "test(mcp): end-to-end smoke passed from published marketplace"
```

---

## Task K2: Ready-to-merge checklist

Before opening a PR from `feature/mcp` → `main`:

- [ ] All phase files in `docs/superpowers/plans/2026-04-21-nova-mcp/` have every task checkbox ticked.
- [ ] `npx vitest run` passes with zero failures.
- [ ] `npx tsc --noEmit` is silent (success).
- [ ] `npm run lint` + `npm run format` produce no diagnostics.
- [ ] `npm run build` succeeds.
- [ ] The infra notes at `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md` reflect the real values discovered during execution (JWKS URL, adapter audit results, probe outcomes, smoke test results).
- [ ] The plan spec at `docs/superpowers/specs/2026-04-21-nova-mcp-design.md` and the plan files in this directory match the shipped behavior (if implementation diverged from the plan, update both — do not merge with drifted docs).
- [ ] No TODOs, FIXMEs, or dead code in `lib/mcp/`, `app/api/[transport]/`, or `lib/agent/tools/`.
- [ ] No `console.log` debugging statements shipped.
- [ ] `lib/mcp/server.ts` registers every MCP-only tool + wraps every shared `lib/agent/tools/*` tool via `registerSharedTool` — total surface ≥ 25 tools.
- [ ] The event-source backfill migration (Phase C Task C1 Step 4) has been run against production Firestore and the full run (not just --dry-run) completed successfully.
- [ ] SA chat-surface regression check from Phase D Task D22 documented — 1442+ tests green, manual web-build smoke produces the same result as pre-refactor main.
